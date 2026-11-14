package com.alg.languagegrowth

import android.content.Context
import android.os.Debug
import android.util.Log
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * 端侧语音合成（评测用）：sherpa-onnx。
 *
 * - [VOICE_KOKORO]：Kokoro int8 多语种（官方包自带 int8，非自量化）
 * - 其余 voice 为历史评测用，当前构建的 assets 里可能不存在，仅按需加载。
 */
object LocalTts {
    private const val TAG = "LocalTts"

    const val VOICE_KOKORO = "kokoro-int8"
    const val VOICE_EN = "en-amy"
    const val VOICE_ZH_EN = "zh-en-melo-fp32"

    /** Piper 官方音色（Sherpa-ONNX 的 VITS Piper 方式加载，espeak-ng-data 三模型共用一份）。 */
    const val VOICE_PIPER_ZH = "piper-zh-huayan-medium"
    const val VOICE_PIPER_EN_MEDIUM = "piper-en-amy-medium"
    const val VOICE_PIPER_EN_HIGH = "piper-en-lessac-high"

    private data class PiperSpec(val assetDir: String, val modelName: String, val label: String)

    val piperSpecs: Map<String, PiperSpec> = mapOf(
        VOICE_PIPER_ZH to PiperSpec("tts-piper/zh_CN-huayan-medium", "zh_CN-huayan-medium.onnx", "huayan-medium"),
        VOICE_PIPER_EN_MEDIUM to PiperSpec("tts-piper/en_US-amy-medium", "en_US-amy-medium.onnx", "amy-medium"),
        VOICE_PIPER_EN_HIGH to PiperSpec("tts-piper/en_US-lessac-high", "en_US-lessac-high.onnx", "lessac-high"),
    )

    fun piperLabel(voice: String): String = piperSpecs[voice]?.label ?: voice

    /** Kokoro 音色：英语 af_heart = sid 3；中文 zf_xiaobei = sid 45（本就是两个人）。 */
    const val SID_EN_AF_HEART = 3
    const val SID_ZH_ZF_XIAOBEI = 45

    data class Bench(
        val voice: String,
        val threads: Int,
        val speed: Float,
        val sid: Int,
        val initMs: Long,
        val firstAudioMs: Long,
        val totalMs: Long,
        val audioMs: Long,
        val peakPssKb: Int,
    ) {
        val rtf: Double get() = totalMs.toDouble() / audioMs.coerceAtLeast(1)
    }

    private val engines = HashMap<String, OfflineTts>()
    private val initCost = HashMap<String, Long>()
    private val lock = Any()

    fun initCostOf(voice: String, threads: Int): Long = initCost["$voice@$threads"] ?: -1L

    @Synchronized
    fun engine(context: Context, voice: String, threads: Int): OfflineTts {
        val key = "$voice@$threads"
        engines[key]?.let { return it }
        val started = System.currentTimeMillis()
        val dir = File(context.filesDir, voice)
        val config: OfflineTtsConfig
        when (voice) {
            VOICE_KOKORO -> {
                val model = File(dir, "model.int8.onnx")
                if (!model.exists()) copyAssetTree(context, "tts-kokoro", dir)
                require(model.exists()) { "kokoro model missing" }
                require(model.length() > 100L * 1024 * 1024) {
                    "kokoro model 只有 ${model.length()} 字节，疑似 LFS 指针，停止加载"
                }
                val espeak = File(dir, "espeak-ng-data")
                config = OfflineTtsConfig(
                    model = OfflineTtsModelConfig(
                        kokoro = OfflineTtsKokoroModelConfig(
                            model = model.absolutePath,
                            voices = File(dir, "voices.bin").absolutePath,
                            tokens = File(dir, "tokens.txt").absolutePath,
                            dataDir = if (espeak.exists()) espeak.absolutePath else "",
                            lexicon = listOf("lexicon-us-en.txt", "lexicon-zh.txt")
                                .map { File(dir, it).absolutePath }
                                .filter { File(it).exists() }
                                .joinToString(","),
                        ),
                        numThreads = threads,
                        debug = false,
                    ),
                    ruleFsts = listOf("phone-zh.fst", "date-zh.fst", "number-zh.fst")
                        .map { File(dir, it).absolutePath }
                        .filter { File(it).exists() }
                        .joinToString(","),
                    maxNumSentences = 1,
                )
            }
            VOICE_ZH_EN -> {
                val model = File(dir, "model.onnx")
                if (!model.exists()) copyAssetTree(context, "tts-melo", dir)
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
            in piperSpecs -> {
                config = piperConfig(context, voice, threads)
            }
            else -> {
                val model = File(dir, "en_US-amy-medium.onnx")
                if (!model.exists()) copyAssetTree(context, "tts", dir)
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
        Log.i(TAG, "init $key ok=${initCost[key]}ms rate=${tts.sampleRate()} speakers=${tts.numSpeakers()}")
        return tts
    }

    /**
     * Piper 配置：模型 + tokens + 共用 espeak-ng-data（espeak 负责音素化）。
     * 模型优先取 filesDir 下已推送的副本，缺失时才从 assets 拷贝。
     */
    private fun piperConfig(context: Context, voice: String, threads: Int): OfflineTtsConfig {
        val spec = piperSpecs.getValue(voice)
        val internalDir = File(context.filesDir, voice)
        val externalRoot = context.getExternalFilesDir(null)?.let { File(it, "tts-piper") }
        val externalDir = externalRoot?.let { File(it, voice) }
        val model = sequenceOf(internalDir, externalDir)
            .filterNotNull()
            .map { File(it, spec.modelName) }
            .firstOrNull { it.exists() }
        if (model == null) {
            copyAssetTree(context, spec.assetDir, internalDir)
        }
        val resolved = model ?: File(internalDir, spec.modelName)
        require(resolved.exists()) { "$voice 模型缺失：${resolved.absolutePath}（可用 adb 推送到 ${externalDir?.absolutePath}）" }
        val modelDir = resolved.parentFile
        val espeak = sequenceOf(internalDir, externalDir, externalRoot)
            .filterNotNull()
            .map { File(it, "espeak-ng-data") }
            .firstOrNull { it.exists() }
            ?: File(context.filesDir, "espeak-ng-data").also { copyAssetTree(context, "tts-piper/espeak-ng-data", it) }
        require(espeak.exists()) { "espeak-ng-data 缺失：${espeak.absolutePath}" }
        Log.i(TAG, "piper $voice model=${resolved.absolutePath} (${resolved.length()}B) espeak=${espeak.absolutePath}")
        return OfflineTtsConfig(
            model = OfflineTtsModelConfig(
                vits = OfflineTtsVitsModelConfig(
                    model = resolved.absolutePath,
                    tokens = File(modelDir, "tokens.txt").absolutePath,
                    dataDir = espeak.absolutePath,
                ),
                numThreads = threads,
                debug = false,
            ),
            maxNumSentences = 1,
        )
    }

    /** 多段拼接，段间插入指定毫秒静音（混排切换用）。返回音频总时长毫秒。 */
    fun concatWavWithGap(
        context: Context,
        parts: List<FloatArray>,
        gapMs: Int,
        sampleRate: Int,
        wavName: String,
    ): Long {
        val gap = (sampleRate.toLong() * gapMs / 1000L).toInt()
        val total = parts.sumOf { it.size } + gap * (parts.size - 1).coerceAtLeast(0)
        val all = FloatArray(total)
        var offset = 0
        parts.forEachIndexed { index, p ->
            p.copyInto(all, offset)
            offset += p.size
            if (index != parts.lastIndex) offset += gap
        }
        val file = File(context.getExternalFilesDir(null) ?: context.filesDir, wavName)
        writeWav(file, all, sampleRate)
        return (total * 1000L) / sampleRate
    }

    /** 当前进程 PSS（MB），用于“双模型常驻”内存对比。 */
    fun pssMb(): Int = pssKb() / 1024

    /** 合成一次（无回调），测量总耗时 / 音频时长 / PSS。 */
    fun synth(
        context: Context,
        voice: String,
        threads: Int,
        sid: Int,
        text: String,
        speed: Float,
        wavName: String? = null,
    ): Bench = synthInternal(context, voice, threads, sid, text, speed, wavName, callback = null)

    /**
     * 合成一次（带流式回调）。callback 必须是显式 object（不用 lambda），
     * 回调里只记时间戳，不分配对象。
     */
    fun synthWithCallback(
        context: Context,
        voice: String,
        threads: Int,
        sid: Int,
        text: String,
        speed: Float,
        wavName: String? = null,
        onFirstChunk: () -> Unit,
    ): Bench {
        val first = FirstChunkRecorder(onFirstChunk)
        return synthInternal(context, voice, threads, sid, text, speed, wavName, first)
    }

    private class FirstChunkRecorder(private val onFirst: () -> Unit) : (FloatArray) -> Int {
        private var fired = false

        override fun invoke(samples: FloatArray): Int {
            if (!fired) {
                fired = true
                onFirst()
            }
            return 0
        }
    }

    private fun synthInternal(
        context: Context,
        voice: String,
        threads: Int,
        sid: Int,
        text: String,
        speed: Float,
        wavName: String?,
        callback: ((FloatArray) -> Int)?,
    ): Bench {
        val tts = engine(context, voice, threads)
        val pssBefore = pssKb()
        var firstAt = 0L
        val t0 = System.nanoTime()
        val audio = synchronized(lock) {
            if (callback != null) {
                tts.generateWithCallback(text = text, sid = sid, speed = speed) { chunk ->
                    if (firstAt == 0L) firstAt = System.nanoTime()
                    callback.invoke(chunk)
                }
            } else {
                tts.generate(text = text, sid = sid, speed = speed)
            }
        }
        val totalMs = (System.nanoTime() - t0) / 1_000_000
        val firstMs = if (firstAt == 0L) totalMs else (firstAt - t0) / 1_000_000
        val audioMs = (audio.samples.size * 1000L) / audio.sampleRate
        if (wavName != null) {
            val file = File(context.getExternalFilesDir(null) ?: context.filesDir, wavName)
            writeWav(file, audio.samples, audio.sampleRate)
        }
        val b = Bench(voice, threads, speed, sid, initCostOf(voice, threads), firstMs, totalMs, audioMs, maxOf(pssBefore, pssKb()))
        Log.i(
            TAG,
            "bench voice=$voice sid=$sid speed=$speed chars=${text.length} initMs=${b.initMs} " +
                "firstMs=${b.firstAudioMs} totalMs=${b.totalMs} audioMs=${b.audioMs} " +
                "rtf=${"%.2f".format(b.rtf)} pssMb=${b.peakPssKb / 1024}",
        )
        return b
    }

    /** 把两段音频拼起来（用于“按语言分段切换 sid”的对照）。 */
    fun concatWav(context: Context, parts: List<FloatArray>, sampleRate: Int, wavName: String): Long {
        val total = parts.sumOf { it.size }
        val all = FloatArray(total)
        var offset = 0
        for (p in parts) {
            p.copyInto(all, offset)
            offset += p.size
        }
        val file = File(context.getExternalFilesDir(null) ?: context.filesDir, wavName)
        writeWav(file, all, sampleRate)
        return (total * 1000L) / sampleRate
    }

    fun generateSamples(context: Context, voice: String, threads: Int, sid: Int, text: String, speed: Float): Pair<FloatArray, Int> {
        val tts = engine(context, voice, threads)
        val audio = synchronized(lock) { tts.generate(text = text, sid = sid, speed = speed) }
        return audio.samples to audio.sampleRate
    }

    private fun pssKb(): Int {
        val info = Debug.MemoryInfo()
        Debug.getMemoryInfo(info)
        @Suppress("DEPRECATION")
        return info.totalPss
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

    /** 递归复制 assets 子目录（Kokoro 需要 espeak-ng-data 的层级结构）。 */
    private fun copyAssetTree(context: Context, assetDir: String, dir: File) {
        dir.mkdirs()
        val children = context.assets.list(assetDir) ?: return
        if (children.isEmpty()) {
            // 叶子是文件
            val name = assetDir.substringAfterLast('/')
            val target = File(dir, name)
            if (!target.exists()) {
                context.assets.open(assetDir).use { input ->
                    FileOutputStream(target).use { output -> input.copyTo(output) }
                }
            }
            return
        }
        for (child in children) {
            val childAsset = "$assetDir/$child"
            val sub = context.assets.list(childAsset)
            if (sub.isNullOrEmpty()) {
                val target = File(dir, child)
                if (!target.exists()) {
                    context.assets.open(childAsset).use { input ->
                        FileOutputStream(target).use { output -> input.copyTo(output) }
                    }
                }
            } else {
                copyAssetTree(context, childAsset, File(dir, child))
            }
        }
    }
}
