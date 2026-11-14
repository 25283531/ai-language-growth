package com.alg.languagegrowth

import android.content.Context
import android.util.Log
import kotlin.math.abs

/**
 * 端侧 TTS 评测台：线程扫描 + 语速矩阵 + fp32/int8 对照。
 *
 * 只通过 adb 触发，不影响正常课堂：
 * adb shell am start -n com.alg.languagegrowth/.MainActivity --ez localtts_bench true
 */
object LocalTtsBench {
    private const val TAG = "LocalTtsBench"

    private data class Sentence(val id: String, val text: String, val kind: String)

    private val sentences = listOf(
        Sentence("greeting", "欢迎回来", "zh"),
        Sentence("zh_teacher", "欢迎回来。上次我们一起练习了身边物品，今天继续学习。", "zh"),
        Sentence("mixed", "我们来读这个单词，family。", "mixed"),
        Sentence("en_sentence", "Hello! Let us read this word together.", "en"),
        Sentence("word", "family", "en"),
    )

    private val speeds = listOf(1.0f, 0.8f, 0.65f)

    fun run(context: Context) {
        try {
            Log.i(TAG, "INT8_STATE=${LocalTts.int8State(context)}")

            // 1) 线程扫描：用中文长句 + 英文句各测 3 次
            val probe = listOf(sentences[1], sentences[3])
            val sweep = HashMap<Int, Double>()
            for (threads in listOf(2, 3, 4)) {
                var totalRtf = 0.0
                var count = 0
                for (s in probe) {
                    repeat(3) { rep ->
                        val b = LocalTts.bench(context, LocalTts.VOICE_ZH_EN, threads, s.text, 1.0f)
                        log(b, s, rep)
                        totalRtf += b.rtf
                        count++
                    }
                }
                sweep[threads] = totalRtf / count
            }
            val best = sweep.minByOrNull { it.value }!!.key
            Log.i(TAG, "THREAD_SWEEP=" + sweep.entries.joinToString(",") { "${it.key}:${"%.2f".format(it.value)}" } + " BEST=$best")

            // 2) 语速矩阵：5 句 × 3 速 × 3 次，取最快线程
            for (s in sentences) {
                for (speed in speeds) {
                    repeat(3) { rep ->
                        val wav = if (rep == 0) "b_${s.id}_${speed}_fp32.wav" else null
                        val b = LocalTts.bench(context, LocalTts.VOICE_ZH_EN, best, s.text, speed, wav)
                        log(b, s, rep)
                    }
                }
            }

            // 3) int8：先尝试加载；可用则跑同一矩阵以便逐句 A/B（不可用就如实记录原因）
            try {
                LocalTts.bench(context, LocalTts.VOICE_ZH_EN_INT8, best, sentences[1].text, 1.0f)
                Log.i(TAG, "INT8_RESULT=usable")
                for (s in sentences) {
                    for (speed in speeds) {
                        repeat(3) { rep ->
                            val wav = if (rep == 0) "b_${s.id}_${speed}_int8.wav" else null
                            val b = LocalTts.bench(context, LocalTts.VOICE_ZH_EN_INT8, best, s.text, speed, wav)
                            log(b, s, rep)
                        }
                    }
                }
            } catch (e: Throwable) {
                Log.i(TAG, "INT8_RESULT=unusable reason=${e.message}")
            }

            Log.i(TAG, "BENCH_DONE")
        } catch (error: Throwable) {
            Log.e(TAG, "BENCH_FAIL", error)
        }
    }

    private fun log(b: LocalTts.Bench, s: Sentence, rep: Int) {
        Log.i(
            TAG,
            "ROW|${s.id}|${s.kind}|${b.voice}|${b.threads}|${b.speed}|$rep|" +
                "${b.initMs}|${b.firstAudioMs}|${b.totalMs}|${b.audioMs}|${"%.2f".format(b.rtf)}|${b.peakPssKb / 1024}",
        )
    }

    /** 三次重复的偏差（毫秒极差），供报告使用。 */
    fun spread(values: List<Long>): Long =
        if (values.isEmpty()) 0 else abs(values.max() - values.min())
}
