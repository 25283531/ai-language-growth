package com.alg.audio.prototype

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Bundle
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
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
    private lateinit var wordText: TextView
    private lateinit var phoneticText: TextView
    private lateinit var pronunciationText: TextView
    private lateinit var submitButton: Button
    private lateinit var startLessonButton: Button
    private lateinit var recordButton: Button

    private var recorder: MediaRecorder? = null
    private var player: MediaPlayer? = null
    private var audioFile: File? = null
    private var audioDurationMs: Long = 0
    private var recordingStartedAtMs: Long? = null
    private var lessonId: String? = null
    private var teacherAudioRef: String? = null
    private var teacherTtsReservationId: String? = null
    private var activeDirective: JSONObject? = null
    private val io: ExecutorService = Executors.newSingleThreadExecutor()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 28, 28, 32)
            setBackgroundColor(Color.rgb(255, 250, 241))
        }
        fun params(top: Int = 14) = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = top }
        fun text(value: String, size: Float, color: Int = Color.rgb(39, 51, 76)) = TextView(this).apply {
            this.text = value
            textSize = size
            setTextColor(color)
        }

        panel.addView(text("小小英语课堂", 22f).apply { setTypeface(null, Typeface.BOLD) }, params(0))
        panel.addView(text("听一听 · 跟着说 · 在情境中用起来", 13f, Color.rgb(120, 126, 141)), params(4))
        statusText = text("还没有开始课堂", 13f, Color.rgb(83, 105, 206))
        panel.addView(statusText, params(18))

        panel.addView(text("今天的课堂", 13f, Color.rgb(120, 126, 141)), params(24))
        wordText = text("hello", 72f, Color.rgb(64, 89, 200)).apply {
            gravity = Gravity.CENTER
            setTypeface(null, Typeface.BOLD)
        }
        panel.addView(wordText, params(4))
        phoneticText = text("/həˈləʊ/", 22f, Color.rgb(125, 132, 147)).apply { gravity = Gravity.CENTER }
        panel.addView(phoneticText, params(0))
        pronunciationText = text("听到老师示范后，在心里跟着说一遍。", 14f, Color.rgb(85, 95, 114)).apply {
            gravity = Gravity.CENTER
        }
        panel.addView(pronunciationText, params(18))

        teacherText = text("小朋友，今天我们学习问候语。先听一听老师怎么说。", 17f).apply {
            setPadding(18, 18, 18, 18)
            setBackgroundColor(Color.rgb(248, 248, 255))
        }
        panel.addView(teacherText, params(22))

        startLessonButton = button("开始今天的课堂") { startLesson() }
        panel.addView(startLessonButton, params(20))
        val replayButton = button("▶  听老师读一遍") { playTeacherAudio() }
        panel.addView(replayButton, params(10))
        recordButton = button("🎤  按住说一说") { toggleRecording() }
        recordButton.isEnabled = false
        panel.addView(recordButton, params(10))
        submitButton = button("提交我的练习") { submitAnswer() }
        submitButton.isEnabled = false
        panel.addView(submitButton, params(10))

        val supportRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val slowButton = button("请老师慢一点") { sendSpeechControl(slower = true) }
        val repeatButton = button("再听一次") { sendSpeechControl(repeat = true) }
        supportRow.addView(slowButton, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        supportRow.addView(repeatButton, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        panel.addView(supportRow, params(8))
        panel.addView(text("老师会根据你的回应，决定下一步是继续跟读、拆开练习，还是带你在句子里使用。", 12f, Color.rgb(145, 148, 158)), params(20))

        setContentView(ScrollView(this).apply { addView(panel) })
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQ_RECORD_AUDIO)
        }
    }

    private fun button(label: String, onClick: () -> Unit): Button = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick() }
    }

    private fun toggleRecording() {
        if (recorder == null) startRecording() else stopRecording()
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
            recordButton.text = "■  停止录音"
            submitButton.isEnabled = false
            setStatus("正在听你说…")
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
            recordButton.text = "🎤  再说一次"
            submitButton.isEnabled = true
            setStatus("听到了，可以提交给老师")
        } catch (e: RuntimeException) {
            setStatus("录音停止异常（可能时长过短）：${e.message}")
        } finally {
            recordingStartedAtMs = null
            recordButton.text = "🎤  再说一次"
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
        val directive: JSONObject? = null,
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
                    postTurn(
                        ref,
                        audioDurationMs,
                        speechQuotaReservationId = reservation.reservationId,
                    ).also {
                        if (it.error == null) settleQuota(reservation.reservationId, seconds)
                        else releaseQuota(reservation.reservationId)
                    }
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
                    setStatus("老师收到你的回答了")
                    teacherText.text = result.teacherUtterance ?: "老师正在准备下一步练习。"
                    teacherAudioRef = result.audioRef
                    activeDirective = result.directive
                    renderDirective(result.directive)
                    submitButton.isEnabled = false
                    if (!teacherAudioRef.isNullOrBlank()) playTeacherAudio()
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
                    activeDirective = result.directive
                    renderDirective(result.directive)
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
        speechQuotaReservationId: String? = null,
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
                if (!speechQuotaReservationId.isNullOrBlank()) {
                    setRequestProperty("X-Speech-Quota-Reservation", speechQuotaReservationId)
                }
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
                TurnResult(utterance, json.optInt("turnIndex", -1), null, speechRef, directive)
            }
        } catch (e: Exception) {
            TurnResult(null, -1, e.message ?: e.javaClass.simpleName)
        } finally {
            connection?.disconnect()
        }
    }

    private fun renderDirective(directive: JSONObject?) {
        if (directive == null) return
        activeDirective = directive
        directive.optString("teacherUtterance").takeIf { it.isNotBlank() }?.let {
            teacherText.text = it
        }

        val targetWords = directive.optJSONArray("targetWords")
        val target = targetWords?.optString(0)?.takeIf { it.isNotBlank() }
        val demonstration = directive.optString("demonstrationText").takeIf { it.isNotBlank() }
        val displayWord = target ?: demonstration
        if (!displayWord.isNullOrBlank()) wordText.text = displayWord

        val units = directive.optJSONArray("pronunciationUnits")
        val unitLabels = (0 until (units?.length() ?: 0)).mapNotNull { index ->
            units?.optJSONObject(index)?.optString("text")?.takeIf { it.isNotBlank() }
        }
        pronunciationText.text = when {
            unitLabels.isNotEmpty() -> "发音小助手：${unitLabels.joinToString(" · ")}"
            !demonstration.isNullOrBlank() -> "先听老师示范，再试着说一说。"
            else -> "跟着老师的提示完成这一小步。"
        }
        val expectedResponse = directive.optString("expectedResponse")
        recordButton.isEnabled = expectedResponse in setOf("repeat", "speak", "answer")
        submitButton.isEnabled = false
        statusText.text = when (expectedResponse) {
            "listen" -> "请先听老师讲解"
            "tap_image" -> "请根据老师的提示选择"
            else -> "准备好后，按下按钮录音"
        }
    }

    private data class LessonStartResult(
        val lessonSessionId: String?,
        val teacherUtterance: String?,
        val audioRef: String?,
        val error: String?,
        val directive: JSONObject? = null,
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
                activeDirective = result.directive
                renderDirective(result.directive)
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
                val directive = json.optJSONObject("directive")
                LessonStartResult(
                    json.optString("lessonSessionId").takeIf { it.isNotEmpty() },
                    directive?.optString("teacherUtterance"),
                    speech?.optString("audioRef")?.takeIf { it.isNotEmpty() }?.let { resolveAudioRef(it) },
                    null,
                    directive,
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
