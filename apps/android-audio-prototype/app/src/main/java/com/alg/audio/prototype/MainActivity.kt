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

    private var recorder: MediaRecorder? = null
    private var player: MediaPlayer? = null
    private var audioFile: File? = null
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

        panel.addView(button("开始录音") { startRecording() }, matchWidth())
        panel.addView(button("停止录音") { stopRecording() }, matchWidth())
        panel.addView(button("播放录音") { playRecording() }, matchWidth())
        submitButton = button("提交作答") { submitAnswer() }
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
            setStatus("录音已停止：${audioFile?.absolutePath}")
        } catch (e: RuntimeException) {
            setStatus("录音停止异常（可能时长过短）：${e.message}")
        } finally {
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
    )

    private fun submitAnswer() {
        val file = audioFile
        if (file == null || !file.exists() || file.length() == 0L) {
            Toast.makeText(this, "请先录音再提交", Toast.LENGTH_SHORT).show()
            return
        }
        // M1 原型：不上传音频字节，只把本地文件路径包装成 audioRef 引用字符串。
        // 真实的对象存储上传与可访问 URL 留待后续里程碑。
        val audioRef = Uri.fromFile(file).toString()
        submitButton.isEnabled = false
        setStatus("提交中… audioRef=$audioRef")
        io.execute {
            val result = postTurn(audioRef)
            runOnUiThread {
                submitButton.isEnabled = true
                if (result.error != null) {
                    setStatus("提交失败：${result.error}")
                } else {
                    setStatus("提交成功，turnIndex=${result.turnIndex}")
                    teacherText.text = result.teacherUtterance
                        ?: "（响应中没有 directive.teacherUtterance）"
                }
            }
        }
    }

    private fun postTurn(audioRef: String): TurnResult {
        val base = getString(R.string.backend_base_url).trimEnd('/')
        val lessonId = getString(R.string.lesson_id)
        val url = URL("$base/lessons/$lessonId/turn")

        // 与 packages/shared-contracts 的 turnRequestSchema 对齐。
        val body = JSONObject().apply {
            put("learnerId", getString(R.string.learner_id))
            put(
                "response",
                JSONObject().apply {
                    put("text", JSONObject.NULL)
                    put("audioRef", audioRef)
                    put("audioDurationMs", 0)
                    put("selectedImageId", JSONObject.NULL)
                    put("requestedSlower", false)
                    put("requestedRepeat", false)
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
                TurnResult(utterance, json.optInt("turnIndex", -1), null)
            }
        } catch (e: Exception) {
            TurnResult(null, -1, e.message ?: e.javaClass.simpleName)
        } finally {
            connection?.disconnect()
        }
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
        releasePlayer()
        io.shutdownNow()
        super.onDestroy()
    }
}
