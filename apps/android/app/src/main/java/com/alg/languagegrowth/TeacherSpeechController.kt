package com.alg.languagegrowth

import android.media.AudioAttributes
import android.media.MediaPlayer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.ceil

private data class AudioPart(val ref: String, val rate: Float)

/**
 * 正式课堂教师语音播放器。
 *
 * 播放顺序：优先用后端 lesson/turn 返回的 speech.segments（服务端已按固定
 * 单词 / 短句 / 文章段落查过缓存）；缺失时才按「先查服务端缓存 → 未命中再
 * 合成」的降级路径取音频。当前一轮的所有音频下载到本地后顺序播放，
 * 「再听一次」只播放本地文件，不再产生任何网络请求或额度结算。
 */
internal class TeacherSpeechController(private val cacheDir: File) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var task: Job? = null
    private var player: MediaPlayer? = null
    private var cachedParts: List<Pair<File, Float>> = emptyList()
    private var generation = 0

    fun stop(clearAudio: Boolean = true) {
        task?.cancel()
        player?.runCatching { if (isPlaying) stop() }
        player?.release()
        player = null
        if (clearAudio) clearCached()
    }

    private fun clearCached() {
        cachedParts.forEach { it.first.delete() }
        cachedParts = emptyList()
    }

    fun close() {
        stop()
        scope.cancel()
    }

    fun play(
        base: String,
        token: String,
        learnerId: String,
        directive: JSONObject,
        speech: JSONObject?,
        replay: Boolean = false,
        onState: (Boolean, String) -> Unit,
    ) {
        val previous = task
        previous?.cancel()
        val currentGeneration = ++generation
        fun emit(active: Boolean, message: String) {
            if (generation == currentGeneration) onState(active, message)
        }
        task = scope.launch {
            previous?.join()
            var reservationId: String? = null
            val pendingFiles = mutableListOf<File>()
            var settled = false
            emit(true, "正在准备老师语音…")
            try {
                if (replay && cachedParts.isNotEmpty() && cachedParts.all { it.first.isFile }) {
                    emit(true, "老师正在说话…")
                    playParts(cachedParts)
                    emit(false, "老师语音播放完毕，可以重播")
                    return@launch
                }

                require(token.isNotBlank() && learnerId.isNotBlank()) { "登录或学习者信息已失效，请重新登录" }
                clearCached()
                var parts = partsFromSpeech(speech)
                val learnerHeaders = mapOf("X-Learner-Id" to learnerId)
                val fallbackTexts = if (parts.isEmpty()) speechTexts(directive) else emptyList()
                require(parts.isNotEmpty() || fallbackTexts.isNotEmpty()) { "本轮没有可播放的老师文本" }

                // 按文本长度估算所需秒数，避免固定预留 120 秒把低额度账户误拒。
                val estimatedSeconds = if (fallbackTexts.isEmpty()) 30.0
                else ceil(fallbackTexts.sumOf { it.length } / 5.0).coerceIn(8.0, 120.0)
                val reservation = withContext(Dispatchers.IO) {
                    http(
                        base, "/speech/quota/reserve", "POST",
                        JSONObject()
                            .put("learnerId", learnerId)
                            .put("serviceKind", "tts")
                            .put("seconds", estimatedSeconds)
                            .put("ttlSeconds", 600)
                            .put("idempotencyKey", "android-tts-${UUID.randomUUID()}"),
                        token,
                    )
                }
                val rid = reservation.optString("reservationId")
                require(rid.isNotBlank() && reservation.optString("status", "reserved") == "reserved") {
                    "语音额度租约不可用"
                }
                reservationId = rid
                val headers = learnerHeaders + ("X-Speech-Quota-Reservation" to rid)

                if (parts.isEmpty()) {
                    val resolved = mutableListOf<AudioPart>()
                    for (text in fallbackTexts) {
                        val body = voiceBody(directive, text, speech)
                        // 先检查服务端缓存资源，命中即复用，不产生供应商 TTS 调用。
                        val lookup = withContext(Dispatchers.IO) {
                            http(base, "/speech/cache/lookup", "POST", body, token, learnerHeaders)
                        }
                        val cached = if (lookup.optBoolean("cached")) lookup.optJSONObject("speech") else null
                        val audio = if (cached != null && safeRef(cached.optString("audioRef"))) {
                            cached
                        } else {
                            withContext(Dispatchers.IO) {
                                http(base, "/speech/synthesize", "POST", body, token, headers)
                            }
                        }
                        resolved += AudioPart(audio.optString("audioRef"), rateOf(audio))
                    }
                    parts = resolved
                }

                val downloaded = mutableListOf<Pair<File, Float>>()
                for (part in parts) {
                    val file = withContext(Dispatchers.IO) {
                        download(base, part.ref, token, headers).also { pendingFiles += it }
                    }
                    downloaded += file to part.rate
                }
                emit(true, "老师正在说话…")
                val durationMs = playParts(downloaded)
                withContext(Dispatchers.IO) {
                    http(
                        base, "/speech/quota/settle", "POST",
                        JSONObject()
                            .put("reservationId", reservationId)
                            .put("seconds", (durationMs / 1000.0).coerceIn(0.0, estimatedSeconds)),
                        token,
                    )
                }
                settled = true
                pendingFiles.clear()
                cachedParts = downloaded
                emit(false, "老师语音播放完毕，可以重播")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                emit(false, "老师语音暂不可用：${e.message ?: "播放失败"}。请先阅读课堂文字，稍后重试。")
            } finally {
                if (!settled) pendingFiles.forEach { it.delete() }
                if (!settled && reservationId != null) {
                    withContext(NonCancellable + Dispatchers.IO) {
                        try {
                            http(
                                base, "/speech/quota/release", "POST",
                                JSONObject().put("reservationId", reservationId), token,
                            )
                        } catch (_: Exception) {
                            withContext(Dispatchers.Main) {
                                emit(false, "语音请求已停止，额度释放暂未确认；租约将自动到期。")
                            }
                        }
                    }
                }
            }
        }
    }

    private fun partsFromSpeech(speech: JSONObject?): List<AudioPart> {
        if (speech == null) return emptyList()
        val segments: JSONArray? = speech.optJSONArray("segments")
        if (segments != null && segments.length() > 0) {
            return (0 until segments.length()).mapNotNull { index ->
                val item = segments.optJSONObject(index) ?: return@mapNotNull null
                val ref = item.optString("audioRef")
                if (!safeRef(ref)) null else AudioPart(ref, rateOf(item))
            }
        }
        val ref = speech.optString("audioRef")
        return if (safeRef(ref)) listOf(AudioPart(ref, rateOf(speech))) else emptyList()
    }

    private fun safeRef(value: String?): Boolean =
        !value.isNullOrBlank() && value != "null" && value.startsWith("/api/v1/media/audio/")

    private fun rateOf(audio: JSONObject): Float {
        val raw = if (audio.optString("speedMode") == "playback") audio.optDouble("playbackRate", 1.0) else 1.0
        require(raw.isFinite() && raw in 0.25..4.0) { "老师语音播放速度不合法" }
        return raw.toFloat()
    }

    /** 与服务端 join(' ') 对齐：teacherUtterance 与 demonstrationText 合成整轮一段文本，不再按字数切段。 */
    private fun speechTexts(directive: JSONObject): List<String> {
        val text = listOf("teacherUtterance", "demonstrationText")
            .map { directive.optString(it).takeUnless { value -> value == "null" }.orEmpty().trim() }
            .filter { it.isNotBlank() }
            .joinToString(" ")
        return if (text.isBlank()) emptyList() else listOf(text)
    }

    private fun voiceBody(directive: JSONObject, text: String, speech: JSONObject?): JSONObject {
        require(text.codePointCount(0, text.length) <= 500) { "本轮老师文本超过语音接口上限，请先阅读课堂文字" }
        val body = JSONObject().put("text", text)
        // 原样透传服务端 speech.scope（课程级缓存归属）；缺失时不臆造，由服务端 fail-closed 到 PRIVATE。
        speech?.optJSONObject("scope")?.let { body.put("scope", it) }
        val voice = directive.optJSONObject("voice")
        listOf("teacherSpeed", "voiceStyle", "pauseAfterSentenceMs", "pronunciationMode").forEach { key ->
            if (voice != null && voice.has(key) && !voice.isNull(key)) body.put(key, voice.get(key))
        }
        return body
    }

    /** 顺序播放全部片段，返回累计时长（毫秒）。 */
    private suspend fun playParts(parts: List<Pair<File, Float>>): Int = withTimeout(540_000) {
        var total = 0
        for ((file, rate) in parts) total += playFile(file, rate)
        total
    }

    private suspend fun playFile(file: File, rate: Float): Int = suspendCancellableCoroutine { continuation ->
        val created = MediaPlayer()
        player = created
        var released = false
        fun cleanup() {
            if (released) return
            released = true
            created.runCatching { if (isPlaying) stop() }
            created.release()
            if (player === created) player = null
        }
        created.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
        )
        created.setOnPreparedListener {
            try {
                if (rate != 1f) it.playbackParams = it.playbackParams.setSpeed(rate)
                it.start()
            } catch (e: Exception) {
                cleanup()
                if (continuation.isActive) continuation.resumeWithException(e)
            }
        }
        created.setOnCompletionListener {
            val duration = it.duration
            cleanup()
            if (continuation.isActive) continuation.resume(duration)
        }
        created.setOnErrorListener { _, _, _ ->
            cleanup()
            if (continuation.isActive) continuation.resumeWithException(IllegalStateException("音频无法解码或播放"))
            true
        }
        continuation.invokeOnCancellation { cleanup() }
        try {
            created.setDataSource(file.absolutePath)
            created.prepareAsync()
        } catch (e: Exception) {
            cleanup()
            if (continuation.isActive) continuation.resumeWithException(e)
        }
    }

    private suspend fun download(base: String, audioRef: String, token: String, headers: Map<String, String>): File {
        val origin = URL(base)
        val target = URL(origin, audioRef)
        require(
            target.protocol == "https" && target.host.equals(origin.host, true) && target.port == origin.port &&
                target.userInfo == null && target.query == null && target.ref == null &&
                Regex("/api/v1/media/audio/[a-fA-F0-9]{24}\\.(mp3|wav|m4a)").matches(target.path),
        ) { "服务端没有返回可安全播放的音频地址" }
        val connection = target.openConnection() as HttpURLConnection
        val file = File.createTempFile("teacher-", ".${target.path.substringAfterLast('.')}", cacheDir)
        try {
            connection.connectTimeout = 10_000
            connection.readTimeout = 30_000
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Authorization", "Bearer $token")
            headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
            require(connection.responseCode in 200..299) { "老师音频下载失败（${connection.responseCode}）" }
            connection.inputStream.use { input ->
                file.outputStream().use { output ->
                    val buffer = ByteArray(8192)
                    var total = 0
                    while (true) {
                        kotlinx.coroutines.currentCoroutineContext().ensureActive()
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        require(total <= 10 * 1024 * 1024) { "老师音频超过大小上限" }
                        output.write(buffer, 0, count)
                    }
                    require(total > 0) { "老师音频为空" }
                }
            }
            return file
        } catch (e: Exception) {
            file.delete()
            throw e
        } finally { connection.disconnect() }
    }
}
