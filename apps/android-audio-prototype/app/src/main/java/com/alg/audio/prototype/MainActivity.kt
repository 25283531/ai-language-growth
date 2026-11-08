package com.alg.audio.prototype

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * M1 最小音频链路原型：录音 → 本地播放 → 提交作答 → 渲染后端返回的 directive。
 *
 * 约束一（D-024）：这里不做任何教学决策。是否换方法、下一句说什么、是否晋级，
 * 全部由后端 /lessons/{id}/turn 决定；本 Activity 只采集音频引用并渲染结果。
 * 约束二（D-024）：代码中不出现任何服务商或模型名称，后端地址仅为配置项。
 */
class MainActivity : Activity() {

    private companion object {
        const val REQ_RECORD_AUDIO = 1001
    }

    private lateinit var statusText: TextView
    private lateinit var teacherText: TextView
    private lateinit var submitButton: Button
    private lateinit var startLessonButton: Button

    private var recorder: MediaRecorder? = null
    private var player: MediaPlayer? = null
    private var audioFile: File? = null
    private var audioDurationMs: Long = 0
    private var recordingStartedAtMs: Long? = null
    private var lessonId: String? = null
    private var teacherAudioRef: String? = null
    private var teacherTtsReservationId: String? = null
    private val io: ExecutorService = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 40, 32, 32)
        }

        fun matchWidth() = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = 16 }

        panel.addView(
            TextView(this).apply {
                text = getString(R.string.app_name)
                textSize = 20f
            },
            matchWidth(),
        )
        panel.addView(
            TextView(this).apply {
                text = "后端：${getString(R.string.backend_base_url)}"
                textSize = 13f
            },
            matchWidth(),
        )

        statusText = TextView(this).apply { text = "就绪"; textSize = 15f }
        panel.addView(statusText, matchWidth())

        startLessonButton = button("开始课堂") { startLesson() }
        panel.addView(startLessonButton, matchWidth())
        panel.addView(button("开始录音") { startRecording() }, matchWidth())
        panel.addView(button("停止录音") { stopRecording() }, matchWidth())
        panel.addView(button("播放录音") { playRecording() }, matchWidth())
        panel.addView(button("播放老师语音") { playTeacherAudio() }, matchWidth())
        panel.addView(button("请老师慢一点") { sendSpeechControl(slower = true) }, matchWidth())
        panel.addView(button("重播老师语音") { sendSpeechControl(repeat = true) }, matchWidth())
        submitButton = button("提交作答") { submitAnswer() }
        submitButton.isEnabled = false
        panel.addView(submitButton, matchWidth())

        panel.addView(
            TextView(this).apply {
                text = "后端 directive.teacherUtterance："
                textSize = 15f
            },
            matchWidth(),
        )
        teacherText = TextView(this).apply {
            text = "（等待提交）"
            textSize = 18f
        }
        panel.addView(teacherText, matchWidth())

        setContentView(ScrollView(this).apply { addView(panel) })

        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_RECORD_AUDIO)
        }
    }

    private fun button(label: String, onClick: () -> Unit): Button =
        Button(this).apply {
            text = label
            setOnClickListener { onClick() }
        }

    // ---------------- 录音 / 播放 ----------------

    private fun startRecording() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            setStatus("缺少录音权限，正在重新申请…")
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_RECORD_AUDIO)
            return
        }
        releaseRecorder()
        releasePlayer()
        val file = File(cacheDir, "m1_answer_${System.currentTimeMillis()}.m4a")
        audioFile = file
        try {
            recorder = MediaRecorder().apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setOutputFile(file.absolutePath)
                prepare()
                start()
            }
            recordingStartedAtMs = System.currentTimeMillis()
            setStatus("录音中 → ${file.name}")
        } catch (e: Exception) {
            releaseRecorder()
            setStatus("录音启动失败：${e.message}")
        }
    }

    private fun stopRecording() {
        val current = recorder
        if (current == null) {
            setStatus("当前没有进行中的录音")
            return
        }
        try {
            current.stop()
            audioDurationMs = (System.currentTimeMillis() - (recordingStartedAtMs ?: System.currentTimeMillis()))
                .coerceAtLeast(1_000)
            recordingStartedAtMs = null
            setStatus("录音已停止：${audioFile?.absolutePath}")
        } catch (e: RuntimeException) {
            setStatus("录音停止异常（可能时长过短）：${e.message}")
        } finally {
            recordingStartedAtMs = null
            releaseRecorder()
        }
    }

    private fun playRecording() {
        val file = audioFile
        if (file == null || !file.exists() || file.length() == 0L) {
            setStatus("没有可播放的录音，请先录音并停止")
            return
        }
        releasePlayer()
        try {
            player = MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnCompletionListener {
                    releasePlayer()
                    setStatus("播放结束")
                }
                prepare()
                start()
            }
            setStatus("播放中…")
        } catch (e: Exception) {
            releasePlayer()
            setStatus("播放失败：${e.message}")
        }
    }

    private fun releaseRecorder() {
        val current = recorder ?: return
        recorder = null
        try {
            current.reset()
        } catch (ignored: Exception) {
            // 释放阶段忽略
        }
        try {
            current.release()
        } catch (ignored: Exception) {
            // 释放阶段忽略
        }
    }

    private fun releasePlayer() {
        val current = player ?: return
        player = null
        try {
            current.release()
        } catch (ignored: Exception) {
            // 释放阶段忽略
        }
    }

    // ---------------- 提交作答 → 后端 turn ----------------

    private data class TurnResult(
        val teacherUtterance: String?,
        val turnIndex: Int,
        val error: String?,
        val audioRef: String? = null,
    )

    private fun submitAnswer() {
        val file = audioFile
        if (file == null || !file.exists() || file.length() == 0L) {
            Toast.makeText(this, "请先录音再提交", Toast.LENGTH_SHORT).show()
            return
        }
        if (lessonId == null) {
            Toast.makeText(this, "请先开始课堂", Toast.LENGTH_SHORT).show()
            return
        }
        submitButton.isEnabled = false
        setStatus("检查今日 ASR 额度…")
        io.execute {
            val result = try {
                val seconds = (audioDurationMs / 1000.0).coerceIn(1.0, 120.0)
                val reservation = reserveQuota("asr", seconds)
                try {
                    val ref = uploadAudio(file, reservation.reservationId)
                    settleQuota(reservation.reservationId, seconds)
                    postTurn(ref, audioDurationMs)
                } catch (e: Exception) {
                    releaseQuota(reservation.reservationId)
                    throw e
                }
            } catch (e: Exception) {
                TurnResult(null, -1, e.message ?: e.javaClass.simpleName)
            }
            runOnUiThread {
                submitButton.isEnabled = true
                if (result.error != null) {
                    setStatus("提交失败：${result.error}")
                } else {
                    setStatus("提交成功，turnIndex=${result.turnIndex}")
                    teacherText.text = result.teacherUtterance
                        ?: "（响应中没有 directive.teacherUtterance）"
                    teacherAudioRef = result.audioRef
                }
            }
        }
    }

    private fun sendSpeechControl(slower: Boolean = false, repeat: Boolean = false) {
        if (lessonId == null) {
            Toast.makeText(this, "请先开始课堂", Toast.LENGTH_SHORT).show()
            return
        }
        setStatus("请求老师${if (slower) "慢一点" else "重播"}…")
        io.execute {
            val result = postTurn(null, requestedSlower = slower, requestedRepeat = repeat)
            runOnUiThread {
                if (result.error != null) {
                    setStatus("请求失败：${result.error}")
                } else {
                    teacherText.text = result.teacherUtterance ?: "（没有返回老师话术）"
                    teacherAudioRef = result.audioRef
                    setStatus("已更新老师语音")
                }
            }
        }
    }

    private fun postTurn(
        audioRef: String?,
        durationMs: Long = 0,
        requestedSlower: Boolean = false,
        requestedRepeat: Boolean = false,
    ): TurnResult {
        val base = getString(R.string.backend_base_url).trimEnd('/')
        val currentLessonId = lessonId ?: throw IllegalStateException("课堂尚未开始")
        val url = URL("$base/lessons/$currentLessonId/turn")

        // 与 packages/shared-contracts 的 turnRequestSchema 对齐。
        val body = JSONObject().apply {
            put("learnerId", getString(R.string.learner_id))
            put(
                "response",
                JSONObject().apply {
                    put("text", JSONObject.NULL)
                    put("audioRef", audioRef ?: JSONObject.NULL)
                    put("audioDurationMs", durationMs)
                    put("selectedImageId", JSONObject.NULL)
                    put("requestedSlower", requestedSlower)
                    put("requestedRepeat", requestedRepeat)
                },
            )
            put("idempotencyKey", UUID.randomUUID().toString())
            put("clientTimestamp", Instant.now().toString())
        }

        var connection: HttpURLConnection? = null
        return try {
            connection = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 8000
                readTimeout = 15000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            }
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }

            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) {
                TurnResult(null, -1, "HTTP $code：$text")
            } else {
                val json = JSONObject(text)
                val directive = json.optJSONObject("directive")
                val utterance = directive?.optString("teacherUtterance")?.takeIf { it.isNotEmpty() }
                val speech = json.optJSONObject("speech")
                val speechRef = speech?.optString("audioRef")?.takeIf { it.isNotEmpty() }
                    ?.let { resolveAudioRef(it) }
                TurnResult(utterance, json.optInt("turnIndex", -1), null, speechRef)
            }
        } catch (e: Exception) {
            TurnResult(null, -1, e.message ?: e.javaClass.simpleName)
        } finally {
            connection?.disconnect()
        }
    }

    private data class LessonStartResult(
        val lessonSessionId: String?,
        val teacherUtterance: String?,
        val audioRef: String?,
        val error: String?,
    )

    private fun startLesson() {
        startLessonButton.isEnabled = false
        setStatus("正在开课…")
        io.execute {
            val result = postLessonStart()
            runOnUiThread {
                startLessonButton.isEnabled = true
                if (result.error != null || result.lessonSessionId == null) {
                    setStatus("开课失败：${result.error ?: "响应缺少 lessonSessionId"}")
                    return@runOnUiThread
                }
                lessonId = result.lessonSessionId
                teacherAudioRef = result.audioRef
                submitButton.isEnabled = true
                teacherText.text = result.teacherUtterance ?: "（等待老师话术）"
                setStatus("课堂已开始：${result.lessonSessionId}")
            }
        }
    }

    private fun postLessonStart(): LessonStartResult {
        val base = getString(R.string.backend_base_url).trimEnd('/')
        val body = JSONObject().apply {
            put("learnerId", getString(R.string.learner_id))
        }
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL("$base/lessons/start").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 8000
                readTimeout = 15000
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=UTF-8")
            }
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) {
                LessonStartResult(null, null, null, "HTTP $code：$text")
            } else {
                val json = JSONObject(text)
                val speech = json.optJSONObject("speech")
                LessonStartResult(
                    json.optString("lessonSessionId").takeIf { it.isNotEmpty() },
                    json.optJSONObject("directive")?.optString("teacherUtterance"),
                    speech?.optString("audioRef")?.takeIf { it.isNotEmpty() }?.let { resolveAudioRef(it) },
                    null,
                )
            }
        } catch (e: Exception) {
            LessonStartResult(null, null, null, e.message ?: e.javaClass.simpleName)
        } finally {
            connection?.disconnect()
        }
    }

    private data class QuotaReservation(val reservationId: String)

    private fun reserveQuota(serviceKind: String, seconds: Double): QuotaReservation {
        val base = getString(R.string.backend_base_url).trimEnd('/')
        val body = JSONObject().apply {
            put("learnerId", getString(R.string.learner_id))
            put("serviceKind", serviceKind)
            put("seconds", seconds)
            put("idempotencyKey", UUID.randomUUID().toString())
        }
        val connection = (URL("$base/speech/quota/reserve").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 8000
            readTimeout = 10000
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=UTF-8")
        }
        try {
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) throw IllegalStateException("今日语音额度不足或租约失败：HTTP $code：$text")
            val id = JSONObject(text).optString("reservationId").takeIf { it.isNotEmpty() }
                ?: throw IllegalStateException("额度接口未返回 reservationId")
            return QuotaReservation(id)
        } finally {
            connection.disconnect()
        }
    }

    private fun settleQuota(reservationId: String, seconds: Double) {
        postQuotaAction("settle", JSONObject().apply {
            put("reservationId", reservationId)
            put("seconds", seconds)
        })
    }

    private fun releaseQuota(reservationId: String) {
        try {
            postQuotaAction("release", JSONObject().apply { put("reservationId", reservationId) })
        } catch (_: Exception) {
            // 网络断开时租约会自然过期，服务端不会把它当作已消耗。
        }
    }

    private fun postQuotaAction(action: String, body: JSONObject) {
        val base = getString(R.string.backend_base_url).trimEnd('/')
        val connection = (URL("$base/speech/quota/$action").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 8000
            readTimeout = 10000
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=UTF-8")
        }
        try {
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            if (code !in 200..299) {
                val text = connection.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
                throw IllegalStateException("额度${action}失败 HTTP $code：$text")
            }
        } finally {
            connection.disconnect()
        }
    }

    private fun uploadAudio(file: File, reservationId: String): String {
        val base = getString(R.string.backend_base_url).trimEnd('/')
        val connection = (URL("$base/media/audio/uploads").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 8000
            readTimeout = 15000
            doOutput = true
            setFixedLengthStreamingMode(file.length())
            setRequestProperty("Content-Type", "audio/mp4")
            setRequestProperty("X-Learner-Id", getString(R.string.learner_id))
            setRequestProperty("X-Speech-Quota-Reservation", reservationId)
        }
        try {
            file.inputStream().use { input ->
                connection.outputStream.use { output -> input.copyTo(output) }
            }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            if (code !in 200..299) throw IllegalStateException("音频上传失败 HTTP $code：$text")
            val ref = JSONObject(text).optString("audioRef").takeIf { it.isNotEmpty() }
                ?: throw IllegalStateException("音频上传响应缺少 audioRef")
            return resolveAudioRef(ref)
        } finally {
            connection.disconnect()
        }
    }

    private fun resolveAudioRef(ref: String): String {
        if (ref.startsWith("http://") || ref.startsWith("https://")) return ref
        val base = getString(R.string.backend_base_url).trimEnd('/')
        val origin = base.substringBefore("/api/v1")
        return if (ref.startsWith("/")) "$origin$ref" else "$origin/$ref"
    }

    private fun playTeacherAudio() {
        val ref = teacherAudioRef
        if (ref.isNullOrBlank()) {
            setStatus("当前没有老师语音")
            return
        }
        releaseTeacherTts()
        releasePlayer()
        setStatus("检查今日 TTS 额度…")
        io.execute {
            val reservation = try {
                // 先预留最大单次播放窗口，下载成功后按播放器实际时长结算。
                reserveQuota("tts", 120.0)
            } catch (e: Exception) {
                runOnUiThread { setStatus("TTS 额度不足，已阻止音频下载：${e.message}") }
                return@execute
            }
            runOnUiThread { startTeacherPlayback(ref, reservation.reservationId) }
        }
    }

    private fun startTeacherPlayback(ref: String, reservationId: String) {
        teacherTtsReservationId = reservationId
        try {
            player = MediaPlayer().apply {
                // 额度租约与学习者绑定；服务端在真正返回音频字节前再次校验。
                setDataSource(
                    this@MainActivity,
                    Uri.parse(ref),
                    mapOf(
                        "X-Learner-Id" to getString(R.string.learner_id),
                        "X-Speech-Quota-Reservation" to reservationId,
                    ),
                )
                setOnPreparedListener {
                    it.start()
                    setStatus("老师语音播放中…")
                }
                setOnCompletionListener {
                    settleTeacherTts(it.duration)
                    releasePlayer()
                    setStatus("老师语音播放结束")
                }
                setOnErrorListener { _, _, _ ->
                    releaseTeacherTts()
                    releasePlayer()
                    setStatus("老师语音播放失败")
                    true
                }
                prepareAsync()
            }
        } catch (e: Exception) {
            releaseTeacherTts()
            releasePlayer()
            setStatus("老师语音播放失败：${e.message}")
        }
    }

    private fun settleTeacherTts(durationMs: Int) {
        val reservationId = teacherTtsReservationId ?: return
        teacherTtsReservationId = null
        val seconds = (durationMs / 1000.0).coerceIn(0.1, 120.0)
        io.execute {
            try {
                settleQuota(reservationId, seconds)
            } catch (_: Exception) {
                // 租约会在服务端过期；不把一次网络断开误报成重复扣费。
            }
        }
    }

    private fun releaseTeacherTts() {
        val reservationId = teacherTtsReservationId ?: return
        teacherTtsReservationId = null
        io.execute { releaseQuota(reservationId) }
    }

    // ---------------- 权限 / 生命周期 ----------------

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_RECORD_AUDIO) return
        if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            setStatus("已获得录音权限，可以开始录音")
        } else {
            setStatus("录音权限被拒绝，录音功能不可用")
        }
    }

    private fun setStatus(message: String) {
        statusText.text = message
    }

    override fun onDestroy() {
        releaseRecorder()
        releaseTeacherTts()
        releasePlayer()
        io.shutdownNow()
        super.onDestroy()
    }
}
