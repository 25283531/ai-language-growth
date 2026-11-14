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
 * 端侧语音合成（实验）：sherpa-onnx 上的两个 VITS 模型。
 *
 * - [VOICE_EN]：Piper amy（英文单语，轻量，用于单词/短句发音）
 * - [VOICE_ZH_EN]：Melo TTS zh_en（中英混说，用于覆盖中文教师话语）
 *
 * 只关心四个评估维度：初始化耗时、单句合成耗时（RTF）、重复合成稳定性、语速可调性。
 * 模型放在 APK assets（CI 构建时下载），首次使用复制到私有目录后交给原生层读绝对路径。
 */
object LocalTts {
    private const val TAG = "LocalTts"

    const val VOICE_EN = "en-amy"
    const val VOICE_ZH_EN = "zh-en-melo"

    private val engines = HashMap<String, OfflineTts>()
    val initMsByVoice = LinkedHashMap<String, Long>()

    @Synchronized
    private fun ensure(context: Context, voice: String): OfflineTts {
        engines[voice]?.let { return it }
        val started = System.currentTimeMillis()
        val dir = File(context.filesDir, voice)
        val config: OfflineTtsConfig
        when (voice) {
            VOICE_ZH_EN -> {
                val model = File(dir, "model.onnx")
                if (!model.exists()) copyAssets(context, "tts-melo", dir)
                config = OfflineTtsConfig(
                    model = OfflineTtsModelConfig(
                        vits = OfflineTtsVitsModelConfig(
                            model = model.absolutePath,
                            tokens = File(dir, "tokens.txt").absolutePath,
                            lexicon = File(dir, "lexicon.txt").absolutePath,
                            // 数字/日期/电话号码等文本归一化规则，中英混排时避免读成乱码。
                            ruleFsts = listOf("phone.fst", "date.fst", "number.fst", "new_heteronym.fst")
                                .map { File(dir, it).absolutePath }
                                .filter { File(it).exists() }
                                .joinToString(","),
                        ),
                        numThreads = 2,
                        debug = false,
                    ),
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
                        numThreads = 2,
                        debug = false,
                    ),
                    maxNumSentences = 1,
                )
            }
        }
        val tts = OfflineTts(assetManager = null, config = config)
        initMsByVoice[voice] = System.currentTimeMillis() - started
        engines[voice] = tts
        Log.i(TAG, "init $voice: ${initMsByVoice[voice]}ms rate=${tts.sampleRate()}")
        return tts
    }

    /** 合成一句并落成 wav，返回（合成耗时、音频时长、文件）。 */
    fun synthesizeToWav(
        context: Context,
        voice: String,
        text: String,
        speed: Float,
        fileName: String,
    ): Triple<Long, Long, File> {
        val tts = ensure(context, voice)
        val started = System.nanoTime()
        val audio = tts.generate(text = text, sid = 0, speed = speed)
        val elapsedMs = (System.nanoTime() - started) / 1_000_000
        val file = File(context.getExternalFilesDir(null) ?: context.filesDir, fileName)
        writeWav(file, audio.samples, audio.sampleRate)
        val audioMs = (audio.samples.size * 1000L) / audio.sampleRate
        Log.i(
            TAG,
            "synth voice=$voice speed=$speed chars=${text.length} ms=$elapsedMs audioMs=$audioMs " +
                "rtf=${"%.2f".format(elapsedMs.toDouble() / audioMs.coerceAtLeast(1))} file=${file.name}",
        )
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
