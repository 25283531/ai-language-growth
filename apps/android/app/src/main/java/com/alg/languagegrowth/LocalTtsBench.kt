package com.alg.languagegrowth

import android.content.Context
import android.util.Log

/**
 * 端侧 TTS 评测台：线程扫描 + 语速矩阵 + fp32/int8 对照。
 *
 * 只通过 adb 触发，不影响正常课堂：
 * adb shell am start -n com.alg.languagegrowth/.MainActivity --ez localtts_bench true
 *
 * 顺序设计：先把保证能跑完的矩阵数据落盘（普通 generate），最后再做可能触发原生崩溃的
 * 流式回调探测，避免一个崩溃吞掉全部结果。
 */
object LocalTtsBench {
    private const val TAG = "LocalTtsBench"

    private data class Sentence(val id: String, val text: String)

    private val sentences = listOf(
        Sentence("greeting", "欢迎回来"),
        Sentence("zh_teacher", "欢迎回来。上次我们一起练习了身边物品，今天继续学习。"),
        Sentence("mixed", "我们来读这个单词，family。"),
        Sentence("en_sentence", "Hello! Let us read this word together."),
        Sentence("word", "family"),
    )

    private val speeds = listOf(1.0f, 0.8f, 0.65f)

    fun run(context: Context) {
        try {
            Log.i(TAG, "ASSET_INT8=${assetState(context, "tts-melo-int8", "model.int8.onnx")}")
            Log.i(TAG, "ASSET_FP32=${assetState(context, "tts-melo", "model.onnx")}")

            for (voice in listOf(LocalTts.VOICE_ZH_EN_INT8, LocalTts.VOICE_ZH_EN)) {
                val tag = if (voice == LocalTts.VOICE_ZH_EN_INT8) "int8" else "fp32"
                val best = sweep(context, voice, tag)
                Log.i(TAG, "BEST_$tag=$best")
                for (s in sentences) {
                    for (speed in speeds) {
                        repeat(3) { rep ->
                            val wav = if (rep == 0) "x_${s.id}_${speed}_$tag.wav" else null
                            val b = LocalTts.bench(context, voice, best, s.text, speed, wav)
                            row(tag, s, b, rep)
                        }
                    }
                }
            }

            Log.i(TAG, "MATRIX_DONE")
            // 最后才做流式回调（首音延迟）；若原生层崩溃，前面的矩阵结果已全部落盘。
            val five = "Welcome back, let us read this word together."
            for (voice in listOf(LocalTts.VOICE_ZH_EN_INT8, LocalTts.VOICE_ZH_EN)) {
                val tag = if (voice == LocalTts.VOICE_ZH_EN_INT8) "int8" else "fp32"
                val b = LocalTts.bench(context, voice, 4, five, 0.65f, useCallback = true)
                Log.i(TAG, "FIRST|$tag|${b.firstAudioMs}|${b.totalMs}|${b.audioMs}|${"%.2f".format(b.rtf)}")
            }
            Log.i(TAG, "BENCH_DONE")
        } catch (error: Throwable) {
            Log.e(TAG, "BENCH_FAIL", error)
        }
    }

    private fun sweep(context: Context, voice: String, tag: String): Int {
        val probe = listOf(sentences[1], sentences[3])
        val avgs = LinkedHashMap<Int, Double>()
        for (threads in listOf(2, 3, 4)) {
            var sum = 0.0
            var n = 0
            for (s in probe) {
                repeat(3) { rep ->
                    val b = LocalTts.bench(context, voice, threads, s.text, 1.0f)
                    row(tag, s, b, rep)
                    sum += b.rtf
                    n++
                }
            }
            avgs[threads] = sum / n
        }
        Log.i(TAG, "SWEEP_$tag=" + avgs.entries.joinToString(",") { "${it.key}:${"%.2f".format(it.value)}" })
        return avgs.minByOrNull { it.value }!!.key
    }

    private fun row(tag: String, s: Sentence, b: LocalTts.Bench, rep: Int) {
        Log.i(
            TAG,
            "ROW|$tag|${s.id}|${b.threads}|${b.speed}|$rep|${b.initMs}|${b.firstAudioMs}|" +
                "${b.totalMs}|${b.audioMs}|${"%.2f".format(b.rtf)}|${b.peakPssKb / 1024}",
        )
    }

    private fun assetState(context: Context, dir: String, file: String): String =
        try {
            val size = context.assets.open("$dir/$file").use { it.available().toLong() }
            if (size < 4096) "pointer($size bytes)" else "ok($size bytes)"
        } catch (e: Throwable) {
            "missing(${e.message})"
        }
}
