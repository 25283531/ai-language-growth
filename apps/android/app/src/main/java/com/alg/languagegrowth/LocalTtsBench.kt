package com.alg.languagegrowth

import android.content.Context
import android.util.Log
import kotlin.concurrent.thread

/**
 * Kokoro int8 头对头评测台（纯 CPU，4 线程，无 NNAPI）。
 *
 * 触发：adb shell am start -n com.alg.languagegrowth/.MainActivity --ez localtts_bench true
 *
 * 执行顺序刻意设计：先跑不依赖流式回调的完整矩阵（保证数据落袋），再跑中英混排的
 * “单 sid / 分段切 sid”对照，最后才在独立 IO 线程上做回调首音探测（已知该回调路径
 * 在部分机型会原生崩溃，崩溃时前面的数据已经写完）。
 */
object LocalTtsBench {
    private const val TAG = "LocalTtsBench"
    private const val THREADS = 4

    private data class Sentence(val id: String, val text: String, val sid: Int)

    private val sentences = listOf(
        Sentence("greeting", "欢迎回来", LocalTts.SID_ZH_ZF_XIAOBEI),
        Sentence("zh_teacher", "欢迎回来。上次我们一起练习了身边物品，今天继续学习。", LocalTts.SID_ZH_ZF_XIAOBEI),
        Sentence("mixed", "我们来读这个单词，family。", LocalTts.SID_ZH_ZF_XIAOBEI),
        Sentence("en_sentence", "Hello! Let us read this word together.", LocalTts.SID_EN_AF_HEART),
        Sentence("word", "family", LocalTts.SID_EN_AF_HEART),
    )

    private val speeds = listOf(1.0f, 0.8f, 0.65f)

    fun run(context: Context) {
        try {
            val t0 = System.currentTimeMillis()
            val tts = LocalTts.engine(context, LocalTts.VOICE_KOKORO, THREADS)
            Log.i(TAG, "INIT|${LocalTts.initCostOf(LocalTts.VOICE_KOKORO, THREADS)}|ms_since_start=${System.currentTimeMillis() - t0}|rate=${tts.sampleRate()}|speakers=${tts.numSpeakers()}")

            // 热身：一个字母，避免把首次加载的抖动算进第一句
            LocalTts.synth(context, LocalTts.VOICE_KOKORO, THREADS, LocalTts.SID_EN_AF_HEART, "a", 1.0f)

            for (s in sentences) {
                for (speed in speeds) {
                    repeat(3) { rep ->
                        val wav = if (rep == 0) "k_${s.id}_${speed}.wav" else null
                        val b = LocalTts.synth(context, LocalTts.VOICE_KOKORO, THREADS, s.sid, s.text, speed, wav)
                        row(s, b, rep)
                    }
                }
            }
            Log.i(TAG, "MATRIX_DONE")

            // 中英混排两种读法：整句单 sid vs 按语言分段切 sid
            mixCompare(context)

            // 最后才碰流式回调
            probeCallback(context)

            Log.i(TAG, "BENCH_DONE")
        } catch (error: Throwable) {
            Log.e(TAG, "BENCH_FAIL", error)
        }
    }

    private fun mixCompare(context: Context) {
        val zhPart = "我们来读这个单词，"
        val enPart = "family"
        for (speed in listOf(1.0f, 0.8f)) {
            val t0 = System.nanoTime()
            LocalTts.synth(context, LocalTts.VOICE_KOKORO, THREADS, LocalTts.SID_ZH_ZF_XIAOBEI, "$zhPart$enPart。", speed, "k_mixed_singlesid_$speed.wav")
            val singleMs = (System.nanoTime() - t0) / 1_000_000

            val t1 = System.nanoTime()
            val (zhSamples, rate) = LocalTts.generateSamples(context, LocalTts.VOICE_KOKORO, THREADS, LocalTts.SID_ZH_ZF_XIAOBEI, zhPart, speed)
            val (enSamples, _) = LocalTts.generateSamples(context, LocalTts.VOICE_KOKORO, THREADS, LocalTts.SID_EN_AF_HEART, enPart, speed)
            val audioMs = LocalTts.concatWav(context, listOf(zhSamples, enSamples), rate, "k_mixed_split_$speed.wav")
            val splitMs = (System.nanoTime() - t1) / 1_000_000
            Log.i(TAG, "MIX|speed=$speed|singleSidMs=$singleMs|splitSidMs=$splitMs|splitAudioMs=$audioMs")
        }
    }

    /**
     * 流式回调探测：独立 IO 线程 + 显式 object 回调 + 每次调用加锁；
     * 先用一个字母热身，再试短句。
     */
    private fun probeCallback(context: Context) {
        val worker = thread(name = "kokoro-callback-probe") {
            try {
                Log.i(TAG, "CB|start")
                LocalTts.synth(context, LocalTts.VOICE_KOKORO, THREADS, LocalTts.SID_EN_AF_HEART, "a", 1.0f)
                Log.i(TAG, "CB|warmup_ok")
                var first = -1L
                val started = System.nanoTime()
                val b = LocalTts.synthWithCallback(
                    context,
                    LocalTts.VOICE_KOKORO,
                    THREADS,
                    LocalTts.SID_EN_AF_HEART,
                    "Hello",
                    0.65f,
                ) { first = (System.nanoTime() - started) / 1_000_000 }
                Log.i(TAG, "CB|short_ok|firstMs=${if (first < 0) b.firstAudioMs else first}|totalMs=${b.totalMs}|audioMs=${b.audioMs}")
                Log.i(TAG, "CB|zh_probe")
                val bz = LocalTts.synthWithCallback(
                    context,
                    LocalTts.VOICE_KOKORO,
                    THREADS,
                    LocalTts.SID_ZH_ZF_XIAOBEI,
                    "欢迎回来",
                    0.65f,
                ) { }
                Log.i(TAG, "CB|zh_ok|firstMs=${bz.firstAudioMs}|totalMs=${bz.totalMs}")
            } catch (error: Throwable) {
                Log.e(TAG, "CB|FAIL", error)
            }
        }
        worker.join(180_000)
        Log.i(TAG, "CB|joined alive=${worker.isAlive}")
    }

    private fun row(s: Sentence, b: LocalTts.Bench, rep: Int) {
        Log.i(
            TAG,
            "ROW|${s.id}|${b.sid}|${b.speed}|$rep|${b.initMs}|${b.totalMs}|${b.audioMs}|${"%.2f".format(b.rtf)}|${b.peakPssKb / 1024}",
        )
    }
}
