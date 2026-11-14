package com.alg.languagegrowth

import android.app.ActivityManager
import android.content.Context
import android.os.Debug
import android.util.Log
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * 端侧语音合成（实验）：sherpa-onnx 上的 VITS 模型。
 *
 * - [VOICE_EN]：Piper amy（英文单语）
 * - [VOICE_ZH_EN]：Melo TTS zh_en fp32（中英混说）
 * - [VOICE_ZH_EN_INT8]：Melo TTS zh_en int8（同一音色、同一 sid，仅权重精度不同）
 *
 * 评估维度：初始化耗时、合成耗时（RTF）、首音延迟（流式回调）、峰值内存、重复稳定性。
 */
object LocalTts {
    private const val TAG = "LocalTts"

    const val VOICE_EN = "en-amy"
    const val VOICE_ZH_EN = "zh-en-melo-fp32"
    const val VOICE_ZH_EN_INT8 = "zh-en-melo-int8"

    data class Bench(
        val voice: String,
        val threads: Int,
        val speed: Float,
        val initMs: Long,
        val firstAudioMs: Long,
        val totalMs: Long,
        val audioMs: Long,
        val peakPssKb: Int,
    ) {
        val rtf: Double get() = totalMs.toDouble() / audioMs.coerceAtLeast(1)
        override fun toString(): String =
            "voice=$voice threads=$threads speed=$speed initMs=$initMs firstMs=$firstAudioMs " +
                "totalMs=$totalMs audioMs=$audioMs rtf=${"%.2f".format(rtf)} pssMb=${peakPssKb / 1024}"
    }

    private val engines = HashMap<String, OfflineTts>()
    private val initCost = HashMap<String, Long>()

    /** int8 资源是否真的可用（发布包里的 int8 可能是 Git LFS 指针）。 */
    fun int8State(context: Context): String {
        val f = File(File(context.filesDir, VOICE_ZH_EN_INT8), "model.int8.onnx")
        if (!f.exists()) return "missing"
        val size = f.length()
        return if (size < 4096) "pointer($size bytes)" else "ok($size bytes)"
    }

    @Synchronized
    fun engine(context: Context, voice: String, threads: Int): OfflineTts {
        val key = "$voice@$threads"
        engines[key]?.let { return it }
        val started = System.currentTimeMillis()
        val dir = File(context.filesDir, voice)
        val config: OfflineTtsConfig
        when (voice) {
            VOICE_ZH_EN, VOICE_ZH_EN_INT8 -> {
                val modelName = if (voice == VOICE_ZH_EN_INT8) "model.int8.onnx" else "model.onnx"
                val model = File(dir, modelName)
                if (!model.exists()) {
                    copyAssets(context, if (voice == VOICE_ZH_EN_INT8) "tts-melo-int8" else "tts-melo", dir)
                }
                require(model.exists()) { "model not found: ${model.absolutePath}" }
                require(model.length() > 4096) {
                    "$modelName 不是可用模型：只有 ${model.length()} 字节（疑似 Git LFS 指针）"
                }
                config = OfflineTtsConfig(
                    model = OfflineTtsModelConfig(
                        vits = OfflineTtsVitsModelConfig(
                            model = model.absolutePath,
                            tokens = File(dir, "tokens.txt").absolutePath,
                            lexicon = File(dir, "lexicon.txt").absolutePath,
                        ),
                        numThreads = threads,
                        debug = false,
                    ),
                    ruleFsts = listOf("phone.fst", "date.fst", "number.fst", "new_heteronym.fst")
                        .map { File(dir, it).absolutePath }
                        .filter { File(it).exists() }
                        .joinToString(","),
                    maxNumSentences = 1,
                )
            }
            else -> {
                val model = File(dir, "en_US-amy-medium.onnx")
                if (!model.exists()) copyAssets(context, "tts", dir)
                config = OfflineTtsConfig(
                    model = OfflineTtsModelConfig(
                        vits = OfflineTtsVitsModelConfig(
                            model = model.absolutePath,
                            tokens = File(dir, "tokens.txt").absolutePath,
                            lexicon = File(dir, "lexicon-en-us.txt").absolutePath,
                        ),
                        numThreads = threads,
                        debug = false,
                    ),
                    maxNumSentences = 1,
                )
            }
        }
        val tts = OfflineTts(assetManager = null, config = config)
        initCost[key] = System.currentTimeMillis() - started
        engines[key] = tts
        Log.i(TAG, "init $key ok=${initCost[key]}ms rate=${tts.sampleRate()}")
        return tts
    }

    /** 合成一次，测量首音延迟 / 总耗时 / 音频时长 / 进程 PSS 峰值。 */
    fun bench(
        context: Context,
        voice: String,
        threads: Int,
        text: String,
        speed: Float,
        wavName: String? = null,
    ): Bench {
        val key = "$voice@$threads"
        val initMs = initCost[key] ?: -1L
        val tts = engine(context, voice, threads)
        val pssBefore = pssKb(context)
        var firstAt = 0L
        var chunks = 0
        val t0 = System.nanoTime()
        val audio = tts.generateWithCallback(text = text, sid = 0, speed = speed) { samples ->
            if (chunks == 0) firstAt = System.nanoTime()
            chunks++
            0
        }
        val totalMs = (System.nanoTime() - t0) / 1_000_000
        val firstMs = if (firstAt == 0L) totalMs else (firstAt - t0) / 1_000_000
        val audioMs = (audio.samples.size * 1000L) / audio.sampleRate
        val pssAfter = pssKb(context)
        if (wavName != null) {
            val file = File(context.getExternalFilesDir(null) ?: context.filesDir, wavName)
            writeWav(file, audio.samples, audio.sampleRate)
        }
        val b = Bench(voice, threads, speed, initMs, firstMs, totalMs, audioMs, maxOf(pssBefore, pssAfter))
        Log.i(TAG, "bench chars=${text.length} $b")
        return b
    }

    private fun pssKb(context: Context): Int {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val info = Debug.MemoryInfo()
        Debug.getMemoryInfo(info)
        @Suppress("DEPRECATION")
        val pss = info.totalPss
        Log.d(TAG, "pss=$pss KB")
        return pss
    }

    private fun writeWav(file: File, samples: FloatArray, sampleRate: Int) {
        val dataSize = samples.size * 2
        val out = ByteBuffer.allocate(44 + dataSize).order(ByteOrder.LITTLE_ENDIAN)
        out.put("RIFF".toByteArray())
        out.putInt(36 + dataSize)
        out.put("WAVEfmt ".toByteArray())
        out.putInt(16)
        out.putShort(1)
        out.putShort(1)
        out.putInt(sampleRate)
        out.putInt(sampleRate * 2)
        out.putShort(2)
        out.putShort(16)
        out.put("data".toByteArray())
        out.putInt(dataSize)
        for (s in samples) {
            val v = (s.coerceIn(-1f, 1f) * 32767).toInt()
            out.putShort(v.toShort())
        }
        FileOutputStream(file).use { it.write(out.array()) }
    }

    private fun copyAssets(context: Context, assetDir: String, dir: File) {
        dir.mkdirs()
        context.assets.list(assetDir)?.forEach { name ->
            val target = File(dir, name)
            if (target.exists()) return@forEach
            context.assets.open("$assetDir/$name").use { input ->
                FileOutputStream(target).use { output -> input.copyTo(output) }
            }
        }
    }
}
