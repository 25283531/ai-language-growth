package com.alg.languagegrowth

import android.content.Context
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
 * 端侧语音合成（实验）：sherpa-onnx + Piper VITS 英文女声。
 *
 * 用途是评估「能不能用端侧合成替代云端按字符计费」，因此这里只关心四件事：
 * 初始化耗时、单句合成耗时（RTF）、同一文本重复合成的稳定性、语速可调性。
 *
 * 模型来自 APK assets/tts（CI 构建时下载），首次启动复制到 filesDir 后再交给
 * 原生层读绝对路径，避免压缩资源无法被 mmap 的问题。
 */
object LocalTts {
    private const val TAG = "LocalTts"
    private const val ASSET_DIR = "tts"

    @Volatile
    private var engine: OfflineTts? = null

    /** 首次初始化耗时（字节复制 + 原生加载），仅用于评估。 */
    @Volatile
    var initMs: Long = -1L
        private set

    private fun ensure(context: Context): OfflineTts {
        engine?.let { return it }
        synchronized(this) {
            engine?.let { return it }
            val started = System.currentTimeMillis()
            val dir = File(context.filesDir, ASSET_DIR)
            val model = File(dir, "en_US-amy-medium.onnx")
            if (!model.exists()) copyAssets(context, dir)

            val config = OfflineTtsConfig(
                model = OfflineTtsModelConfig(
                    vits = OfflineTtsVitsModelConfig(
                        model = model.absolutePath,
                        tokens = File(dir, "tokens.txt").absolutePath,
                        // 英文用 lexicon 发音，不依赖 espeak-ng-data 目录。
                        lexicon = File(dir, "lexicon-en-us.txt").absolutePath,
                        lengthScale = 1.0f,
                    ),
                    numThreads = 2,
                    debug = false,
                ),
                maxNumSentences = 1,
            )
            val tts = OfflineTts(assetManager = null, config = config)
            initMs = System.currentTimeMillis() - started
            engine = tts
            Log.i(TAG, "init ok: ${initMs}ms sampleRate=${tts.sampleRate()} speakers=${tts.numSpeakers()}")
            return tts
        }
    }

    /** 合成一句并落成 wav，返回（耗时、音频时长）。 */
    fun synthesizeToWav(
        context: Context,
        text: String,
        speed: Float,
        fileName: String,
    ): Triple<Long, Long, File> {
        val tts = ensure(context)
        val started = System.nanoTime()
        val audio = tts.generate(text = text, sid = 0, speed = speed)
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        val samples = audio.samples
        val file = File(context.getExternalFilesDir(null) ?: context.filesDir, fileName)
        writeWav(file, samples, audio.sampleRate)
        val audioMs = (samples.size * 1000L) / audio.sampleRate
        Log.i(TAG, "synth speed=$speed ms=$elapsedMs audioMs=$audioMs rtf=${"%.2f".format(elapsedMs.toDouble() / audioMs.coerceAtLeast(1))} file=${file.name}")
        return Triple(elapsedMs, audioMs, file)
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

    private fun copyAssets(context: Context, dir: File) {
        dir.mkdirs()
        val assets = context.assets
        assets.list(ASSET_DIR)?.forEach { name ->
            val target = File(dir, name)
            if (target.exists()) return@forEach
            context.assets.open("$ASSET_DIR/$name").use { input ->
                FileOutputStream(target).use { output -> input.copyTo(output) }
            }
        }
    }
}
