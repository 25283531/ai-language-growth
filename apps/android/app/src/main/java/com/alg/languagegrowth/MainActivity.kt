package com.alg.languagegrowth

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

private const val OFFICIAL_API = "https://152.136.230.132:3000/api/v1"
private val Forest = Color(0xFF176B5B)
private val Ink = Color(0xFF202B28)
private val Muted = Color(0xFF64716C)
private val ChildCoral = Color(0xFFE66A55)
private val ChildBlue = Color(0xFF3478B8)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val appearance = getSharedPreferences("appearance", MODE_PRIVATE)
        val account = getSharedPreferences("account", MODE_PRIVATE)
        setContent {
            var childTheme by remember { mutableStateOf(appearance.getBoolean("childTheme", true)) }
            val colors = if (childTheme) lightColorScheme(primary = ChildCoral, secondary = ChildBlue, onPrimary = Color.White, background = Color(0xFFFFF7EF), surface = Color.White, onSurface = Color(0xFF29323B))
            else lightColorScheme(primary = Forest, secondary = Color(0xFF557A73), onPrimary = Color.White, background = Color(0xFFF5F7F4), surface = Color.White, onSurface = Ink)
            MaterialTheme(colorScheme = colors) {
                GrowthApp(account, childTheme, { childTheme = it; appearance.edit().putBoolean("childTheme", it).apply() })
            }
        }
    }
}

@Composable
private fun GrowthApp(account: android.content.SharedPreferences, childTheme: Boolean, onTheme: (Boolean) -> Unit) {
    val scope = rememberCoroutineScope()
    var page by remember { mutableStateOf(if (account.getString("token", null).isNullOrBlank()) "auth" else "home") }
    var register by remember { mutableStateOf(false) }
    var official by remember { mutableStateOf(account.getBoolean("official", true)) }
    var custom by remember { mutableStateOf(account.getString("custom", "") ?: "") }
    var menu by remember { mutableStateOf(false) }
    var email by remember { mutableStateOf(account.getString("email", "") ?: "") }
    var password by remember { mutableStateOf("") }
    var displayName by remember { mutableStateOf("") }
    var captchaId by remember { mutableStateOf("") }
    var captchaSvg by remember { mutableStateOf("") }
    var captchaCode by remember { mutableStateOf("") }
    var verificationCode by remember { mutableStateOf("") }
    var learnerId by remember { mutableStateOf("") }
    var emailVerified by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var lessonText by remember { mutableStateOf("") }

    fun base(): String {
        val value = if (official) OFFICIAL_API else custom.trim().trimEnd('/')
        require(value.startsWith("https://")) { "服务器地址必须使用 HTTPS。" }
        return if (value.endsWith("/api/v1")) value else "$value/api/v1"
    }
    fun token() = account.getString("token", null)
    fun loadCaptcha() {
        scope.launch {
            try {
                val response = withContext(Dispatchers.IO) { http(base(), "/auth/captcha", "GET") }
                captchaId = response.getString("captchaId")
                captchaSvg = response.getString("image")
                captchaCode = ""
            } catch (e: Exception) { status = e.message ?: "验证码加载失败" }
        }
    }
    fun loadMe() {
        scope.launch {
            try {
                val response = withContext(Dispatchers.IO) { http(base(), "/auth/me", "GET", token = token()) }
                val user = response.getJSONObject("user")
                email = user.optString("email")
                learnerId = user.optString("learnerId")
                emailVerified = !user.isNull("emailVerifiedAt")
                account.edit().putString("email", email).apply()
                page = "home"
            } catch (e: Exception) { account.edit().remove("token").apply(); page = "auth"; status = e.message ?: "登录已失效" }
        }
    }

    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("英语成长课堂", fontSize = if (childTheme) 29.sp else 27.sp, fontWeight = FontWeight.Bold)
            when (page) {
                "auth" -> {
                    Text(if (register) "创建学习账户" else "登录后继续学习", color = Muted)
                    OutlinedButton(onClick = { menu = true }, Modifier.fillMaxWidth()) { Text(if (official) "服务：官方服务" else "服务：自定义服务器") }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem(text = { Text("官方服务") }, onClick = { official = true; menu = false; account.edit().putBoolean("official", true).apply(); if (register) loadCaptcha() })
                        DropdownMenuItem(text = { Text("自定义服务器") }, onClick = { official = false; menu = false; account.edit().putBoolean("official", false).apply(); if (register) loadCaptcha() })
                    }
                    if (!official) OutlinedTextField(custom, { custom = it }, Modifier.fillMaxWidth(), label = { Text("服务器地址") }, placeholder = { Text("https://example.com/api/v1") }, singleLine = true)
                    OutlinedTextField(email, { email = it }, Modifier.fillMaxWidth(), label = { Text("邮箱") }, singleLine = true)
                    if (register) OutlinedTextField(displayName, { displayName = it }, Modifier.fillMaxWidth(), label = { Text("显示名称（可选）") }, singleLine = true)
                    OutlinedTextField(password, { password = it }, Modifier.fillMaxWidth(), label = { Text("密码") }, singleLine = true)
                    if (register) {
                        if (captchaSvg.isBlank()) OutlinedButton({ loadCaptcha() }, Modifier.fillMaxWidth()) { Text("加载图片验证码") }
                        else {
                            AndroidView(factory = { context -> WebView(context).apply { settings.javaScriptEnabled = false } }, update = { it.loadData(captchaSvg, "image/svg+xml", "base64") }, Modifier.fillMaxWidth().height(64.dp))
                            OutlinedTextField(captchaCode, { captchaCode = it.filter(Char::isDigit).take(4) }, Modifier.fillMaxWidth(), label = { Text("4 位图片验证码") }, singleLine = true)
                            OutlinedButton({ loadCaptcha() }, Modifier.fillMaxWidth()) { Text("换一张验证码") }
                            Text("密码至少 6 位，不能使用连续数字或重复数字。", color = Muted, fontSize = 13.sp)
                        }
                    }
                    Button(onClick = {
                        scope.launch {
                            busy = true
                            try {
                                val body = JSONObject().put("email", email.trim()).put("password", password)
                                val path = if (register) {
                                    require(captchaId.isNotBlank() && captchaCode.length == 4) { "请先完成图片验证码。" }
                                    body.put("displayName", displayName).put("captchaId", captchaId).put("captchaCode", captchaCode)
                                    "/auth/register"
                                } else "/auth/login"
                                val result = withContext(Dispatchers.IO) { http(base(), path, "POST", body) }
                                account.edit().putString("token", result.getString("accessToken")).putString("email", email.trim()).putString("custom", custom).apply()
                                password = ""
                                loadMe()
                            } catch (e: Exception) { status = e.message ?: "操作失败"; if (register) loadCaptcha() }
                            finally { busy = false }
                        }
                    }, enabled = !busy && email.contains("@") && password.isNotBlank() && (official || custom.isNotBlank()), Modifier.fillMaxWidth().height(52.dp)) {
                        if (busy) CircularProgressIndicator(Modifier.height(20.dp), color = Color.White, strokeWidth = 2.dp) else Text(if (register) "注册" else "登录")
                    }
                    OutlinedButton(onClick = { register = !register; status = ""; if (register) loadCaptcha() }, Modifier.fillMaxWidth()) { Text(if (register) "已有账户？返回登录" else "创建新账户") }
                }
                "settings" -> {
                    Text("账户设置", color = Muted)
                    Text(email, fontWeight = FontWeight.SemiBold)
                    Text(if (emailVerified) "邮箱已验证" else "邮箱尚未验证", color = if (emailVerified) Forest else ChildCoral)
                    Text("只有完成邮箱验证后，才能使用邮箱找回密码。", color = Muted)
                    if (!emailVerified) {
                        OutlinedButton(onClick = {
                            scope.launch { try { val r = withContext(Dispatchers.IO) { http(base(), "/auth/email-verification", "POST", token = token()) }; status = r.optString("message") } catch (e: Exception) { status = e.message ?: "发送失败" } }
                        }, Modifier.fillMaxWidth()) { Text("发送邮箱验证码") }
                        OutlinedTextField(verificationCode, { verificationCode = it.filter(Char::isDigit).take(6) }, Modifier.fillMaxWidth(), label = { Text("6 位邮箱验证码") }, singleLine = true)
                        Button(onClick = {
                            scope.launch { try { val r = withContext(Dispatchers.IO) { http(base(), "/auth/verify-email", "POST", JSONObject().put("code", verificationCode), token()) }; status = r.optString("message"); emailVerified = true } catch (e: Exception) { status = e.message ?: "验证失败" } }
                        }, enabled = verificationCode.length == 6, Modifier.fillMaxWidth()) { Text("确认验证") }
                    }
                    OutlinedButton({ onTheme(!childTheme) }, Modifier.fillMaxWidth()) { Text(if (childTheme) "切换成人主题" else "切换儿童主题") }
                    OutlinedButton({ page = "home" }, Modifier.fillMaxWidth()) { Text("返回课堂") }
                    OutlinedButton({ account.edit().remove("token").apply(); page = "auth"; register = false }, Modifier.fillMaxWidth()) { Text("退出登录") }
                }
                else -> {
                    Text(if (childTheme) "今天也可以慢慢来。" else "按自己的节奏，稳步积累。", color = Muted)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton({ page = "settings" }) { Text("账户设置") }
                        OutlinedButton({ onTheme(!childTheme) }) { Text(if (childTheme) "成人主题" else "儿童主题") }
                    }
                    Button(onClick = {
                        scope.launch {
                            busy = true
                            try {
                                require(learnerId.isNotBlank()) { "账户暂未关联学习者档案，请联系管理员。" }
                                val r = withContext(Dispatchers.IO) { http(base(), "/lessons/start", "POST", JSONObject().put("learnerId", learnerId), token()) }
                                val d = r.getJSONObject("directive")
                                lessonText = "${r.optString("topicName")}\n${d.optString("teacherUtterance")}\n${d.optString("demonstrationText")}"
                                status = "课堂已准备好"
                            } catch (e: Exception) { status = e.message ?: "暂时无法连接" }
                            finally { busy = false }
                        }
                    }, enabled = !busy, Modifier.fillMaxWidth().height(52.dp)) {
                        if (busy) CircularProgressIndicator(Modifier.height(20.dp), color = Color.White, strokeWidth = 2.dp) else Text("开始课堂")
                    }
                    if (lessonText.isNotBlank()) Text(lessonText, fontSize = if (childTheme) 22.sp else 19.sp, lineHeight = 30.sp)
                }
            }
            if (status.isNotBlank()) Text(status, color = Muted)
        }
    }
    if (page == "home" && learnerId.isBlank() && account.getString("token", null) != null) LaunchedEffect(Unit) { loadMe() }
}

private fun http(base: String, path: String, method: String, body: JSONObject? = null, token: String? = null): JSONObject {
    val connection = URL("${base.trimEnd('/')}$path").openConnection() as HttpURLConnection
    connection.requestMethod = method
    connection.connectTimeout = 10_000
    connection.readTimeout = 20_000
    connection.setRequestProperty("Accept", "application/json")
    if (!token.isNullOrBlank()) connection.setRequestProperty("Authorization", "Bearer $token")
    if (body != null) {
        connection.doOutput = true
        connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8")
        connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
    }
    return try {
        val code = connection.responseCode
        val text = (if (code in 200..299) connection.inputStream else connection.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
        val result = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
        if (code !in 200..299) error(result.optString("message").ifBlank { "请求失败（$code）" })
        result
    } finally { connection.disconnect() }
}
