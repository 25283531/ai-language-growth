package com.alg.languagegrowth

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

private val Forest = Color(0xFF176B5B)
private val Ink = Color(0xFF202B28)
private val Muted = Color(0xFF64716C)
private val ChildCoral = Color(0xFFE66A55)
private val ChildBlue = Color(0xFF3478B8)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val preferences = getSharedPreferences("appearance", MODE_PRIVATE)
        setContent {
            var childTheme by remember { mutableStateOf(preferences.getBoolean("childTheme", true)) }
            val colors = if (childTheme) {
                lightColorScheme(
                    primary = ChildCoral,
                    secondary = ChildBlue,
                    onPrimary = Color.White,
                    background = Color(0xFFFFF7EF),
                    surface = Color.White,
                    onSurface = Color(0xFF29323B),
                )
            } else {
                lightColorScheme(
                    primary = Forest,
                    secondary = Color(0xFF557A73),
                    onPrimary = Color.White,
                    background = Color(0xFFF5F7F4),
                    surface = Color.White,
                    onSurface = Ink,
                )
            }
            MaterialTheme(colorScheme = colors) {
                LessonHome(
                    childTheme = childTheme,
                    onThemeChange = { enabled ->
                        childTheme = enabled
                        preferences.edit().putBoolean("childTheme", enabled).apply()
                    },
                )
            }
        }
    }
}

@androidx.compose.runtime.Composable
private fun LessonHome(childTheme: Boolean, onThemeChange: (Boolean) -> Unit) {
    val scope = rememberCoroutineScope()
    var backend by remember { mutableStateOf("") }
    var learnerId by remember { mutableStateOf("child-m1-demo") }
    var busy by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("准备好开始今天的英语练习了吗？") }
    var lessonId by remember { mutableStateOf<String?>(null) }
    var topicName by remember { mutableStateOf("") }
    var teacherText by remember { mutableStateOf("") }
    var demoText by remember { mutableStateOf("") }
    var targetWords by remember { mutableStateOf("") }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 28.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text("英语成长课堂", fontSize = if (childTheme) 29.sp else 27.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurface)
            Text(if (childTheme) "今天也可以慢慢来。" else "按自己的节奏，稳步积累。", color = Muted, fontSize = 16.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = { onThemeChange(true) },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (childTheme) MaterialTheme.colorScheme.primary else Color(0xFFE9ECEF),
                        contentColor = if (childTheme) Color.White else Ink,
                    ),
                ) { Text("儿童") }
                Button(
                    onClick = { onThemeChange(false) },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (!childTheme) MaterialTheme.colorScheme.primary else Color(0xFFE9ECEF),
                        contentColor = if (!childTheme) Color.White else Ink,
                    ),
                ) { Text("成人") }
            }
            OutlinedTextField(
                value = learnerId,
                onValueChange = { learnerId = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("学习者编号") },
                singleLine = true,
            )
            OutlinedTextField(
                value = backend,
                onValueChange = { backend = it.trim() },
                modifier = Modifier.fillMaxWidth(),
                label = { Text("安全后端地址（HTTPS）") },
                placeholder = { Text("https://your-domain/api/v1") },
                supportingText = { Text("儿童数据只通过 HTTPS 发送。") },
                singleLine = true,
            )
            Button(
                onClick = {
                    scope.launch {
                        busy = true
                        status = "正在连接课堂…"
                        try {
                            val lesson = withContext(Dispatchers.IO) { startLesson(backend, learnerId) }
                            lessonId = lesson.id
                            topicName = lesson.topicName
                            teacherText = lesson.teacherText
                            demoText = lesson.demoText
                            targetWords = lesson.targetWords
                            status = "课堂已准备好"
                        } catch (error: Exception) {
                            status = error.message ?: "暂时无法连接，请检查网络和地址。"
                        } finally {
                            busy = false
                        }
                    }
                },
                enabled = !busy && learnerId.isNotBlank() && backend.isNotBlank(),
                modifier = Modifier.fillMaxWidth().height(54.dp),
            ) {
                if (busy) {
                    CircularProgressIndicator(modifier = Modifier.height(20.dp), color = Color.White, strokeWidth = 2.dp)
                } else {
                    Text(if (lessonId == null) "开始课堂" else "重新开始", fontSize = 17.sp)
                }
            }
            Text(status, color = Muted)
            if (lessonId != null) {
                Spacer(Modifier.height(4.dp))
                Text(topicName, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
                Text(teacherText, fontSize = if (childTheme) 24.sp else 21.sp, lineHeight = 31.sp, fontWeight = FontWeight.Medium)
                if (demoText.isNotBlank()) {
                    Text("跟老师读", color = Muted, fontSize = 14.sp)
                    Text(demoText, fontSize = if (childTheme) 34.sp else 30.sp, lineHeight = 40.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                }
                if (targetWords.isNotBlank()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("本轮练习", color = Muted)
                        Text(targetWords, fontWeight = FontWeight.SemiBold)
                    }
                }
                Text("课堂编号：${lessonId!!.take(8)}", color = Muted, fontSize = 12.sp)
            }
        }
    }
}

private data class StartedLesson(
    val id: String,
    val topicName: String,
    val teacherText: String,
    val demoText: String,
    val targetWords: String,
)

private fun startLesson(baseUrl: String, learnerId: String): StartedLesson {
    val trimmed = baseUrl.trim().trimEnd('/')
    val parsed = URL(trimmed)
    require(parsed.protocol == "https") { "请填写 HTTPS 后端地址。" }
    val endpoint = if (trimmed.endsWith("/api/v1")) trimmed else "$trimmed/api/v1"
    val connection = URL("$endpoint/lessons/start").openConnection() as HttpURLConnection
    connection.requestMethod = "POST"
    connection.connectTimeout = 8_000
    connection.readTimeout = 20_000
    connection.doOutput = true
    connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
    return try {
        val payload = JSONObject().put("learnerId", learnerId.trim())
        connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
        val code = connection.responseCode
        val stream = if (code in 200..299) connection.inputStream else connection.errorStream
        val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        if (code !in 200..299) error("课堂连接失败（$code），请检查学习者编号。")
        val response = JSONObject(text)
        val directive = response.getJSONObject("directive")
        StartedLesson(
            id = response.getString("lessonSessionId"),
            topicName = response.optString("topicName"),
            teacherText = directive.optString("teacherUtterance"),
            demoText = directive.optString("demonstrationText").takeUnless { it == "null" }.orEmpty(),
            targetWords = (0 until directive.optJSONArray("targetWords").let { it?.length() ?: 0 })
                .mapNotNull { directive.optJSONArray("targetWords")?.optString(it) }
                .joinToString(" · "),
        )
    } finally {
        connection.disconnect()
    }
}
