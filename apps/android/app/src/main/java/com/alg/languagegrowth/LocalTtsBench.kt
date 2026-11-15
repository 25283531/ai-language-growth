package com.alg.languagegrowth

import android.content.Context
import android.util.Log

/**
 * Piper（Sherpa-ONNX VITS Piper 路径）评测台。
 *
 * 固定条件：同一台 Redmi K30，纯 CPU，4 线程，不开 NNAPI；
 * 全部走普通 [com.k2fsa.sherpa.onnx.OfflineTts.generate]，**刻意不使用 generateWithCallback**
 * （Sherpa v2.0.1 + 该机型首回调必闪退，已复现）。
 *
 * 触发：
 * adb shell am start -n com.alg.languagegrowth/.MainActivity \
 *   --ez localtts_bench true --es localtts_bench_mode zh
 *
 * mode：
 * - zh    中文 huayan-medium 全矩阵 + 中文专项句
 * - enm   英文 amy-medium 全矩阵 + 中文专项句
 * - enh   英文 lessac-high 全矩阵 + 中文专项句
 * - mix   混排分段（huayan + amy / huayan + lessac，中间 80ms 静音）
 * - co    双模型/三模型常驻内存
 * - all   依次跑 zh → enm → enh → mix → co（内存数字会互相污染，只作兜底）
 */
object LocalTtsBench {
    private const val TAG = "LocalTtsBench"
    private const val THREADS = 4
    private const val GAP_MS = 80

    private data class Sentence(val id: String, val text: String)

    /** 与上一轮 Melo/Kokoro 完全相同的 5 句，不换句。 */
    private val sentences = listOf(
        Sentence("01_greeting", "欢迎回来"),
        Sentence("02_zh_teacher", "欢迎回来。上次我们一起练习了身边物品，今天继续学习。"),
        Sentence("03_mixed", "我们来读这个单词，family。"),
        Sentence("04_en_sentence", "Hello! Let us read this word together."),
        Sentence("05_word", "family"),
    )

    /** 中文专项：声调 / 多音字 / 数字日期。 */
    private val zhSpecials = listOf(
        Sentence("s1_tone", "妈麻马骂"),
        Sentence("s2_polyphone", "行长很长，重量很重，银行很行。"),
        Sentence("s3_number_date", "2026 年 11 月 15 日，下午 3 点 20 分，电话 13812345678。"),
    )

    private val speeds = listOf(1.0f, 0.8f, 0.65f)
    private val specialSpeeds = listOf(1.0f)

    fun run(context: Context, mode: String) {
        try {
            when (mode) {
                "zh" -> matrix(context, LocalTts.VOICE_PIPER_ZH)
                "enm" -> matrix(context, LocalTts.VOICE_PIPER_EN_MEDIUM)
                "enh" -> matrix(context, LocalTts.VOICE_PIPER_EN_HIGH)
                "mix" -> mixed(context)
                "co" -> coResident(context)
                else -> {
                    matrix(context, LocalTts.VOICE_PIPER_ZH)
                    matrix(context, LocalTts.VOICE_PIPER_EN_MEDIUM)
                    matrix(context, LocalTts.VOICE_PIPER_EN_HIGH)
                    mixed(context)
                    coResident(context)
                }
            }
            Log.i(TAG, "BENCH_DONE|mode=$mode")
        } catch (error: Throwable) {
            Log.e(TAG, "BENCH_FAIL|mode=$mode", error)
        }
    }

    private fun matrix(context: Context, voice: String) {
        val label = LocalTts.piperLabel(voice)
        val t0 = System.currentTimeMillis()
        val tts = LocalTts.engine(context, voice, THREADS)
        Log.i(
            TAG,
            "INIT|$label|${LocalTts.initCostOf(voice, THREADS)}|wallMs=${System.currentTimeMillis() - t0}" +
                "|rate=${tts.sampleRate()}|speakers=${tts.numSpeakers()}|pssMb=${LocalTts.pssMb()}",
        )
        // 热身：一个字母，避免首句抖动混进第一档
        LocalTts.synth(context, voice, THREADS, 0, "a", 1.0f)
        Log.i(TAG, "WARM|$label|pssMb=${LocalTts.pssMb()}")

        var peak = LocalTts.pssMb()
        for (s in sentences) {
            for (speed in speeds) {
                repeat(3) { rep ->
                    val wav = if (rep == 0) "${label}__${s.id}__x$speed.wav" else null
                    val b = LocalTts.synth(context, voice, THREADS, 0, s.text, speed, wav)
                    val pss = b.peakPssKb / 1024
                    peak = maxOf(peak, pss)
                    Log.i(
                        TAG,
                        "ROW|$label|${s.id}|$speed|$rep|${b.totalMs}|${b.audioMs}|" +
                            "${"%.3f".format(b.rtf)}|$pss",
                    )
                }
            }
        }

        for (s in zhSpecials) {
            for (speed in specialSpeeds) {
                val b = LocalTts.synth(context, voice, THREADS, 0, s.text, speed, "${label}__${s.id}__x$speed.wav")
                val pss = b.peakPssKb / 1024
                peak = maxOf(peak, pss)
                Log.i(
                    TAG,
                    "SPECIAL|$label|${s.id}|$speed|${b.totalMs}|${b.audioMs}|" +
                        "${"%.3f".format(b.rtf)}|$pss",
                )
            }
        }
        Log.i(TAG, "PEAK|$label|$peak")
    }

    /**
     * 混排两种读法：整句单模型（huayan 一段读完）vs 中文走 huayan、英文单词走英文模型，
     * 分段合成后中间插 80ms 静音拼接；两档英文模型各测一次。
     */
    private fun mixed(context: Context) {
        val zhPart = "我们来读这个单词，"
        val enPart = "family"
        val pairs = listOf(
            LocalTts.VOICE_PIPER_EN_MEDIUM to "medium",
            LocalTts.VOICE_PIPER_EN_HIGH to "high",
        )
        for (speed in listOf(1.0f, 0.8f)) {
            val singleStart = System.nanoTime()
            LocalTts.synth(
                context,
                LocalTts.VOICE_PIPER_ZH,
                THREADS,
                0,
                "$zhPart$enPart。",
                speed,
                "huayan-medium__06_mixed_singlesid__x$speed.wav",
            )
            val singleMs = (System.nanoTime() - singleStart) / 1_000_000

            for ((enVoice, tag) in pairs) {
                val t1 = System.nanoTime()
                val (zhSamples, rate) = LocalTts.generateSamples(context, LocalTts.VOICE_PIPER_ZH, THREADS, 0, zhPart, speed)
                val zhMs = (System.nanoTime() - t1) / 1_000_000

                val t2 = System.nanoTime()
                val (enSamples, enRate) = LocalTts.generateSamples(context, enVoice, THREADS, 0, enPart, speed)
                val enMs = (System.nanoTime() - t2) / 1_000_000

                val wavName = "split_huayan+${tag}__03_mixed__x${speed}.wav"
                val audioMs = LocalTts.concatWavWithGap(context, listOf(zhSamples, enSamples), GAP_MS, rate, wavName)
                val splitMs = zhMs + enMs
                Log.i(
                    TAG,
                    "MIX|$tag|$speed|zhMs=$zhMs|enMs=$enMs|splitMs=$splitMs|singleSidMs=$singleMs" +
                        "|gapMs=$GAP_MS|audioMs=$audioMs|rate=$rate|enRate=$enRate" +
                        "|deltaVsSingleMs=${splitMs - singleMs}",
                )
            }
        }
    }

    /** 常驻内存：单模型 → 中英双模型 → 三模型全在，逐级读 PSS。 */
    private fun coResident(context: Context) {
        fun hold(voice: String) {
            LocalTts.engine(context, voice, THREADS)
            LocalTts.synth(context, voice, THREADS, 0, "a", 1.0f)
        }

        hold(LocalTts.VOICE_PIPER_ZH)
        Log.i(TAG, "CO|zh_only|pssMb=${LocalTts.pssMb()}")

        hold(LocalTts.VOICE_PIPER_EN_MEDIUM)
        Log.i(TAG, "CO|zh+medium|pssMb=${LocalTts.pssMb()}")

        hold(LocalTts.VOICE_PIPER_EN_HIGH)
        Log.i(TAG, "CO|zh+medium+high|pssMb=${LocalTts.pssMb()}")

        // 双模型交替合成，确认常驻后仍可用
        for (i in 0 until 2) {
            LocalTts.synth(context, LocalTts.VOICE_PIPER_ZH, THREADS, 0, "欢迎回来", 1.0f)
            LocalTts.synth(context, LocalTts.VOICE_PIPER_EN_MEDIUM, THREADS, 0, "family", 1.0f)
        }
        Log.i(TAG, "CO|after_alternating|pssMb=${LocalTts.pssMb()}")
    }
}
