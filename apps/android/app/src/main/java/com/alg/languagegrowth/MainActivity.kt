package com.alg.languagegrowth

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
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
private val ChildCoral = Color(0xFFE66A55)
private val ChildBlue = Color(0xFF3478B8)
private val Muted = Color(0xFF65716D)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val appearance = getSharedPreferences("appearance", MODE_PRIVATE)
        val account = getSharedPreferences("account", MODE_PRIVATE)
        setContent {
            var childTheme by remember { mutableStateOf(appearance.getBoolean("childTheme", true)) }
            val scheme = if (childTheme) lightColorScheme(
                primary = ChildCoral, secondary = ChildBlue, background = Color(0xFFFFF8F1),
                surface = Color.White, onSurface = Color(0xFF29323B), onPrimary = Color.White,
            ) else lightColorScheme(
                primary = Forest, secondary = Color(0xFF557A73), background = Color(0xFFF4F7F4),
                surface = Color.White, onSurface = Color(0xFF202B28), onPrimary = Color.White,
            )
            MaterialTheme(colorScheme = scheme) {
                GrowthApp(
                    account,
                    childTheme,
                    { childTheme = it; appearance.edit().putBoolean("childTheme", it).apply() },
                )
            }
        }
    }
}

private data class Tab(val key: String, val title: String)
private val tabs = listOf(Tab("home", "首页"), Tab("learn", "学习"), Tab("achievements", "成就"), Tab("me", "我"))

@Composable
private fun GrowthApp(
    account: android.content.SharedPreferences,
    childTheme: Boolean,
    onTheme: (Boolean) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var loggedIn by remember { mutableStateOf(!account.getString("token", null).isNullOrBlank()) }
    var tab by remember { mutableStateOf("home") }
    var register by remember { mutableStateOf(false) }
    var official by remember { mutableStateOf(account.getBoolean("official", true)) }
    var custom by remember { mutableStateOf(account.getString("custom", "") ?: "") }
    var serverMenu by remember { mutableStateOf(false) }
    var email by remember { mutableStateOf(account.getString("email", "") ?: "") }
    var password by remember { mutableStateOf("") }
    var displayName by remember { mutableStateOf("") }
    var captchaId by remember { mutableStateOf("") }
    var captchaSvg by remember { mutableStateOf("") }
    var captchaCode by remember { mutableStateOf("") }
    var captchaStatus by remember { mutableStateOf("") }
    var learnerId by remember { mutableStateOf("") }
    var emailVerified by remember { mutableStateOf(false) }
    var pageStatus by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var dashboard by remember { mutableStateOf<JSONObject?>(null) }
    var lessonText by remember { mutableStateOf("") }
    var screen by remember { mutableStateOf("tabs") }
    var editName by remember { mutableStateOf("") }
    var avatarUrl by remember { mutableStateOf("") }
    var currentPassword by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var selectedTextbook by remember { mutableStateOf("") }
    var verificationCode by remember { mutableStateOf("") }

    fun base(): String {
        val value = if (official) OFFICIAL_API else custom.trim().trimEnd('/')
        require(value.startsWith("https://")) { "服务器地址必须使用 HTTPS。" }
        return if (value.endsWith("/api/v1")) value else "$value/api/v1"
    }
    fun token() = account.getString("token", null)

    suspend fun fetchDashboard() {
        val result = withContext(Dispatchers.IO) { http(base(), "/user/dashboard", "GET", token = token()) }
        dashboard = result
        val user = result.getJSONObject("user")
        val learner = result.getJSONObject("learner")
        email = user.optString("email")
        learnerId = learner.optString("id")
        emailVerified = !user.isNull("emailVerifiedAt")
        editName = user.optString("displayName")
        avatarUrl = user.optString("avatarUrl").takeUnless { it == "null" }.orEmpty()
        account.edit().putString("email", email).apply()
    }

    fun loadCaptcha() {
        scope.launch {
            captchaStatus = "正在加载验证码"
            try {
                val response = withContext(Dispatchers.IO) { http(base(), "/auth/captcha", "GET") }
                captchaId = response.getString("captchaId")
                captchaSvg = response.getString("image")
                captchaCode = ""
                captchaStatus = ""
            } catch (e: Exception) {
                captchaStatus = e.message ?: "验证码加载失败"
            }
        }
    }

    fun startSession() {
        scope.launch {
            busy = true
            pageStatus = ""
            try {
                require(learnerId.isNotBlank()) { "账户尚未关联学习档案。" }
                val response = withContext(Dispatchers.IO) {
                    http(base(), "/lessons/start", "POST", JSONObject().put("learnerId", learnerId), token())
                }
                val directive = response.optJSONObject("directive") ?: JSONObject()
                lessonText = listOf(
                    response.optString("topicName"),
                    directive.optString("teacherUtterance"),
                    directive.optString("demonstrationText"),
                ).filter { it.isNotBlank() && it != "null" }.joinToString("\n\n")
                if (lessonText.isBlank()) lessonText = "今天的课堂已经准备好，跟着老师一起开始吧！"
                tab = "learn"
                pageStatus = ""
            } catch (e: Exception) {
                pageStatus = e.message ?: "暂时无法开始课堂"
            } finally {
                busy = false
            }
        }
    }

    if (!loggedIn) {
        AuthScreen(
            register, official, custom, serverMenu, email, password, displayName, captchaSvg,
            captchaCode, captchaStatus, busy, pageStatus, onRegisterToggle = {
                register = !register
                pageStatus = ""
                captchaStatus = ""
                if (register) loadCaptcha()
            },
            onServerMenu = { serverMenu = it },
            onOfficial = {
                official = it
                account.edit().putBoolean("official", it).apply()
                serverMenu = false
                if (register) loadCaptcha()
            },
            onCustom = { custom = it },
            onEmail = { email = it },
            onPassword = { password = it },
            onName = { displayName = it },
            onCaptcha = { captchaCode = it.filter(Char::isDigit).take(4) },
            onRefreshCaptcha = ::loadCaptcha,
            onSubmit = {
                scope.launch {
                    busy = true
                    pageStatus = ""
                    try {
                        val body = JSONObject().put("email", email.trim()).put("password", password)
                        val path = if (register) {
                            require(captchaId.isNotBlank() && captchaCode.length == 4) { "请先完成图片验证码。" }
                            body.put("displayName", displayName).put("captchaId", captchaId).put("captchaCode", captchaCode)
                            "/auth/register"
                        } else "/auth/login"
                        val result = withContext(Dispatchers.IO) { http(base(), path, "POST", body) }
                        account.edit()
                            .putString("token", result.getString("accessToken"))
                            .putString("email", email.trim())
                            .putString("custom", custom)
                            .apply()
                        password = ""
                        loggedIn = true
                        tab = "home"
                        screen = "tabs"
                        captchaStatus = ""
                        pageStatus = if (register) "注册成功，欢迎加入英语成长课堂！" else ""
                        try {
                            fetchDashboard()
                        } catch (e: Exception) {
                            pageStatus = "账户已${if (register) "注册" else "登录"}，但暂时无法加载学习资料：${e.message ?: "请稍后刷新"}"
                        }
                    } catch (e: Exception) {
                        pageStatus = e.message ?: "操作失败"
                        if (register) loadCaptcha()
                    } finally {
                        busy = false
                    }
                }
            },
        )
        return
    }

    LaunchedEffect(Unit) {
        if (dashboard == null) runCatching { fetchDashboard() }
            .onFailure { pageStatus = it.message ?: "学习资料加载失败" }
    }

    Scaffold(
        bottomBar = {
            if (screen == "tabs") NavigationBar {
                tabs.forEach { item ->
                    NavigationBarItem(
                        selected = tab == item.key,
                        onClick = { tab = item.key; pageStatus = "" },
                        icon = { Text(when (item.key) { "home" -> "⌂"; "learn" -> "▶"; "achievements" -> "★"; else -> "●" }, fontSize = 20.sp) },
                        label = { Text(item.title) },
                    )
                }
            }
        },
    ) { inset ->
        Column(
            Modifier.fillMaxSize().padding(inset).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (screen == "legal_privacy" || screen == "legal_terms") {
                Text(if (screen == "legal_privacy") "隐私协议" else "用户协议", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(if (screen == "legal_privacy") "我们仅处理提供学习服务所需的账户资料与学习记录。语音功能按服务配置处理；学习记录用于生成个性化课程进度。你可以在“我”页面申请注销账户。" else "使用本服务时，请由监护人协助未成年人完成账户注册与学习设置。学习建议仅用于辅助学习，能力阶段以服务端记录为准。", color = Muted, lineHeight = 25.sp)
                OutlinedButton(onClick = { screen = "tabs" }) { Text("返回") }
            } else if (screen == "tabs") {
                Text(when (tab) { "home" -> "英语成长课堂"; "learn" -> "今天学什么"; "achievements" -> "成长成就"; else -> "我的账户" }, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                when (tab) {
                    "home" -> HomeScreen(dashboard, childTheme, pageStatus, onStart = ::startSession, onRefresh = {
                        scope.launch { runCatching { fetchDashboard() }.onFailure { pageStatus = it.message ?: "刷新失败" } }
                    })
                    "learn" -> LearnScreen(lessonText, busy, pageStatus, ::startSession)
                    "achievements" -> AchievementScreen(dashboard)
                    else -> ProfileScreen(
                        dashboard, editName, { editName = it }, avatarUrl, { avatarUrl = it },
                        currentPassword, { currentPassword = it }, newPassword, { newPassword = it },
                        selectedTextbook, { selectedTextbook = it }, emailVerified,
                        verificationCode, { verificationCode = it.filter(Char::isDigit).take(6) },
                        pageStatus, childTheme, onTheme,
                        onSaveProfile = {
                            scope.launch {
                                busy = true
                                try {
                                    withContext(Dispatchers.IO) {
                                        http(base(), "/user/profile", "PUT", JSONObject().put("displayName", editName).put("avatarUrl", avatarUrl.ifBlank { JSONObject.NULL }), token())
                                    }
                                    fetchDashboard()
                                    pageStatus = "资料已保存"
                                } catch (e: Exception) { pageStatus = e.message ?: "保存失败" } finally { busy = false }
                            }
                        },
                        onPassword = {
                            scope.launch {
                                busy = true
                                try {
                                    withContext(Dispatchers.IO) {
                                        http(base(), "/user/password", "PUT", JSONObject().put("currentPassword", currentPassword).put("newPassword", newPassword), token())
                                    }
                                    account.edit().remove("token").apply()
                                    loggedIn = false
                                    pageStatus = "密码已修改，请使用新密码登录"
                                    currentPassword = ""
                                    newPassword = ""
                                } catch (e: Exception) { pageStatus = e.message ?: "修改失败" } finally { busy = false }
                            }
                        },
                        onTextbook = {
                            scope.launch {
                                busy = true
                                try {
                                    withContext(Dispatchers.IO) { http(base(), "/user/textbook", "PUT", JSONObject().put("textbookId", selectedTextbook), token()) }
                                    fetchDashboard()
                                    pageStatus = "教材已更新"
                                } catch (e: Exception) { pageStatus = e.message ?: "教材更新失败" } finally { busy = false }
                            }
                        },
                        onVerify = {
                            scope.launch {
                                try {
                                    withContext(Dispatchers.IO) { http(base(), "/auth/verify-email", "POST", JSONObject().put("code", verificationCode), token()) }
                                    fetchDashboard()
                                    pageStatus = "邮箱验证完成"
                                } catch (e: Exception) { pageStatus = e.message ?: "验证失败" }
                            }
                        },
                        onSendVerification = {
                            scope.launch {
                                try {
                                    val response = withContext(Dispatchers.IO) { http(base(), "/auth/email-verification", "POST", token = token()) }
                                    pageStatus = response.optString("message")
                                } catch (e: Exception) { pageStatus = e.message ?: "发送失败" }
                            }
                        },
                        onPrivacy = { screen = "legal_privacy" },
                        onTerms = { screen = "legal_terms" },
                        onLogout = {
                            account.edit().remove("token").apply()
                            loggedIn = false
                            register = false
                            pageStatus = ""
                        },
                        onDelete = {
                            scope.launch {
                                busy = true
                                try {
                                    withContext(Dispatchers.IO) { http(base(), "/user/account", "DELETE", token = token()) }
                                    account.edit().remove("token").apply()
                                    loggedIn = false
                                    pageStatus = "账户已注销"
                                } catch (e: Exception) { pageStatus = e.message ?: "注销失败" } finally { busy = false }
                            }
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun AuthScreen(
    register: Boolean, official: Boolean, custom: String, serverMenu: Boolean, email: String,
    password: String, displayName: String, captchaSvg: String, captchaCode: String,
    captchaStatus: String, busy: Boolean, pageStatus: String, onRegisterToggle: () -> Unit,
    onServerMenu: (Boolean) -> Unit, onOfficial: (Boolean) -> Unit, onCustom: (String) -> Unit,
    onEmail: (String) -> Unit, onPassword: (String) -> Unit, onName: (String) -> Unit,
    onCaptcha: (String) -> Unit, onRefreshCaptcha: () -> Unit, onSubmit: () -> Unit,
) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Spacer(Modifier.height(20.dp))
        Text("英语成长课堂", fontSize = 29.sp, fontWeight = FontWeight.Bold)
        Text(if (register) "创建学习账户" else "登录后继续学习", color = Muted)
        Box {
            OutlinedButton(onClick = { onServerMenu(true) }, modifier = Modifier.fillMaxWidth()) {
                Text(if (official) "服务：官方服务" else "服务：自定义服务器")
            }
            DropdownMenu(serverMenu, { onServerMenu(false) }) {
                DropdownMenuItem(text = { Text("官方服务") }, onClick = { onOfficial(true) })
                DropdownMenuItem(text = { Text("自定义服务器") }, onClick = { onOfficial(false) })
            }
        }
        if (!official) Field(custom, onCustom, "服务器地址", "https://example.com/api/v1")
        Field(email, onEmail, "邮箱")
        if (register) Field(displayName, onName, "学习者昵称（可选）")
        Field(password, onPassword, "密码", password = true)
        if (register) {
            if (captchaSvg.isNotBlank()) {
                AndroidView(
                    factory = { WebView(it).apply { settings.javaScriptEnabled = false } },
                    update = { it.loadData(Base64Svg(captchaSvg), "image/svg+xml", "UTF-8") },
                    modifier = Modifier.fillMaxWidth().height(64.dp),
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(captchaCode, onCaptcha, Modifier.weight(1f), label = { Text("4 位图片验证码") }, singleLine = true)
                TextButton(onClick = onRefreshCaptcha) { Text("换一张") }
            }
            if (captchaStatus.isNotBlank()) Text(captchaStatus, color = Muted)
            Text("密码至少 6 位，请避免使用连续数字或重复数字。", color = Muted, fontSize = 13.sp)
        }
        Button(onClick = onSubmit, enabled = !busy && email.contains("@") && password.isNotBlank(), modifier = Modifier.fillMaxWidth().height(52.dp)) {
            if (busy) CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
            else Text(if (register) "注册" else "登录")
        }
        TextButton(onClick = onRegisterToggle, modifier = Modifier.fillMaxWidth()) {
            Text(if (register) "已有账户？返回登录" else "创建新账户")
        }
        if (pageStatus.isNotBlank()) Text(pageStatus, color = MaterialTheme.colorScheme.primary)
    }
}

private fun Base64Svg(value: String): String = try {
    String(android.util.Base64.decode(value, android.util.Base64.DEFAULT), Charsets.UTF_8)
} catch (_: Exception) { "" }

@Composable
private fun HomeScreen(data: JSONObject?, childTheme: Boolean, status: String, onStart: () -> Unit, onRefresh: () -> Unit) {
    val user = data?.optJSONObject("user")
    val learner = data?.optJSONObject("learner")
    val stats = data?.optJSONObject("stats")
    val name = learner?.optString("displayName").orEmpty().ifBlank { user?.optString("displayName").orEmpty() }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Box(Modifier.size(62.dp).background(MaterialTheme.colorScheme.primary.copy(alpha = .14f), CircleShape), Alignment.Center) {
            Text(name.take(1).ifBlank { "学" }, fontSize = 26.sp, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
        }
        Column {
            Text("你好，${name.ifBlank { "学习者" }}", fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Text(user?.optString("email").orEmpty(), color = Muted, fontSize = 13.sp)
        }
    }
    Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surface, tonalElevation = 1.dp) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("我的学习进度", fontWeight = FontWeight.Bold)
            Text("当前级别：${learner?.optString("entryLevel")?.uppercase() ?: "PRE-A1"}", color = Muted)
            val mapping = data?.optJSONObject("textbook")
            Text("教材：${mapping?.optString("publisher")?.takeIf { it != "null" } ?: "尚未选择"} ${mapping?.optString("grade").orEmpty()}", color = Muted)
            Text("已学习 ${stats?.optInt("usedWords", 0) ?: 0} 个词汇 · 连续学习 ${stats?.optInt("streak", 0) ?: 0} 天", color = Muted)
        }
    }
    Text("七项能力", fontSize = 18.sp, fontWeight = FontWeight.Bold)
    val abilities = data?.optJSONArray("abilities")
    val labels = listOf("听力", "语音", "词汇", "语法", "口语", "交流", "学校")
    labels.forEach { label ->
        val stage = (0 until (abilities?.length() ?: 0)).mapNotNull { abilities?.optJSONObject(it) }
            .firstOrNull { it.optString("label") == label }
        AbilityRow(label, stage?.optInt("stage", 0) ?: 0, stage?.optBoolean("calibrated", false) ?: false)
    }
    Button(onClick = onStart, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text(if (childTheme) "开始今天的学习" else "开始学习") }
    OutlinedButton(onClick = onRefresh, modifier = Modifier.fillMaxWidth()) { Text("刷新学习进度") }
    if (status.isNotBlank()) Text(status, color = MaterialTheme.colorScheme.primary)
    Text(data?.optString("calibrationNotice").orEmpty(), color = Muted, fontSize = 12.sp)
}

@Composable
private fun AbilityRow(label: String, stage: Int, calibrated: Boolean) {
    val stageText = when (stage) { 0 -> "待开始"; 1 -> "正在接触"; 2 -> "练习中"; 3 -> "持续巩固"; else -> "阶段稳定" }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.width(58.dp), fontWeight = FontWeight.Medium)
        LinearProgressIndicator(progress = { stage.coerceIn(0, 4) / 4f }, Modifier.weight(1f).height(8.dp))
        Text(if (calibrated) stageText else if (stage == 0) "待开始" else "$stageText*", Modifier.width(92.dp).padding(start = 8.dp), fontSize = 12.sp, color = Muted)
    }
}

@Composable
private fun LearnScreen(lessonText: String, busy: Boolean, status: String, onStart: () -> Unit) {
    Text("跟随老师的节奏，完成一小段练习。", color = Muted)
    Button(onClick = onStart, enabled = !busy, modifier = Modifier.fillMaxWidth().height(54.dp)) {
        if (busy) CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp) else Text(if (lessonText.isBlank()) "开始学习" else "再来一节")
    }
    if (lessonText.isNotBlank()) {
        Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
            Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                Text("今天的课堂", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                lessonText.split("\n\n").filter { it.isNotBlank() }.forEach { Text(it, fontSize = 22.sp, lineHeight = 31.sp) }
                Text("准备好后，可以跟着老师读一读或回答问题。", color = Muted)
            }
        }
    } else {
        Text("课程会根据你的学习进度调整。", color = Muted)
    }
    if (status.isNotBlank()) Text(status, color = MaterialTheme.colorScheme.primary)
}

@Composable
private fun AchievementScreen(data: JSONObject?) {
    val stats = data?.optJSONObject("stats")
    Text("每一步练习，都会成为成长的证据。", color = Muted)
    val values = listOf(
        "会默写的词" to (stats?.optInt("dictationWords", 0) ?: 0).toString(),
        "能听懂的词" to (stats?.optInt("understoodWords", 0) ?: 0).toString(),
        "能使用的词" to (stats?.optInt("usedWords", 0) ?: 0).toString(),
        "掌握的语法类别" to (stats?.optInt("grammarCategories", 0) ?: 0).toString(),
        "发音标准词数" to (stats?.optInt("pronunciationWords", 0) ?: 0).toString(),
        "口语能力评分" to (stats?.optDouble("speakingScore", 0.0) ?: 0.0).toString(),
    )
    values.chunked(2).forEach { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            row.forEach { (label, value) ->
                Surface(Modifier.weight(1f), shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surface, tonalElevation = 1.dp) {
                    Column(Modifier.padding(14.dp)) {
                        Text(value, fontSize = 25.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                        Text(label, color = Muted, fontSize = 13.sp)
                    }
                }
            }
            if (row.size == 1) Spacer(Modifier.weight(1f))
        }
    }
    Text("学习勋章", fontSize = 18.sp, fontWeight = FontWeight.Bold)
    val achievements = data?.optJSONObject("achievements")
    listOf(
        "百词斩" to "hundredWords", "连续学习 10 天" to "streak10",
        "连续学习 20 天" to "streak20", "连续学习 30 天" to "streak30",
        "连续学习 50 天" to "streak50", "连续学习 100 天" to "streak100",
    ).forEach { (label, key) ->
        val earned = achievements?.optBoolean(key, false) ?: false
        Surface(shape = RoundedCornerShape(8.dp), color = if (earned) MaterialTheme.colorScheme.primary.copy(alpha = .12f) else MaterialTheme.colorScheme.surface) {
            Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (earned) "★" else "☆", fontSize = 23.sp, color = MaterialTheme.colorScheme.primary)
                Text(label, Modifier.padding(start = 12.dp), fontWeight = FontWeight.Medium)
                Spacer(Modifier.weight(1f))
                Text(if (earned) "已获得" else "继续加油", color = Muted, fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun ProfileScreen(
    data: JSONObject?, name: String, onName: (String) -> Unit, avatar: String, onAvatar: (String) -> Unit,
    currentPassword: String, onCurrentPassword: (String) -> Unit, newPassword: String, onNewPassword: (String) -> Unit,
    selectedTextbook: String, onSelectedTextbook: (String) -> Unit, emailVerified: Boolean,
    code: String, onCode: (String) -> Unit, status: String, childTheme: Boolean, onTheme: (Boolean) -> Unit,
    onSaveProfile: () -> Unit, onPassword: () -> Unit, onTextbook: () -> Unit,
    onVerify: () -> Unit, onSendVerification: () -> Unit, onPrivacy: () -> Unit, onTerms: () -> Unit,
    onLogout: () -> Unit, onDelete: () -> Unit,
) {
    val user = data?.optJSONObject("user")
    var textbookMenu by remember { mutableStateOf(false) }
    val textbooks = data?.optJSONArray("textbooks")
    val textbookLabels = (0 until (textbooks?.length() ?: 0)).mapNotNull { index ->
        textbooks?.optJSONObject(index)?.let { it.optString("id") to "${it.optString("publisher")} · ${it.optInt("publicationYear")} · ${it.optString("grade")} ${it.optString("title")}" }
    }
    Text(user?.optString("email").orEmpty(), color = Muted)
    OutlinedTextField(name, onName, Modifier.fillMaxWidth(), label = { Text("个人资料名称") }, singleLine = true)
    OutlinedTextField(avatar, onAvatar, Modifier.fillMaxWidth(), label = { Text("头像图片网址") }, placeholder = { Text("https://...") }, singleLine = true)
    Button(onClick = onSaveProfile, modifier = Modifier.fillMaxWidth()) { Text("保存资料") }
    Text("邮箱${if (emailVerified) "已验证" else "尚未验证"}", color = if (emailVerified) Forest else ChildCoral)
    if (!emailVerified) {
        Text("只有验证邮箱后，才能使用邮箱找回密码。", color = Muted, fontSize = 13.sp)
        OutlinedButton(onClick = onSendVerification, modifier = Modifier.fillMaxWidth()) { Text("发送验证邮件") }
        OutlinedTextField(code, onCode, Modifier.fillMaxWidth(), label = { Text("6 位邮箱验证码") }, singleLine = true)
        Button(onClick = onVerify, enabled = code.length == 6, modifier = Modifier.fillMaxWidth()) { Text("验证邮箱") }
    }
    Text("修改密码", fontSize = 18.sp, fontWeight = FontWeight.Bold)
    Field(currentPassword, onCurrentPassword, "当前密码", password = true)
    Field(newPassword, onNewPassword, "新密码（至少 6 位）", password = true)
    OutlinedButton(onClick = onPassword, modifier = Modifier.fillMaxWidth()) { Text("更新密码") }
    Text("选择教材", fontSize = 18.sp, fontWeight = FontWeight.Bold)
    Box {
        OutlinedButton(onClick = { textbookMenu = true }, modifier = Modifier.fillMaxWidth()) {
            Text(textbookLabels.firstOrNull { it.first == selectedTextbook }?.second ?: "选择教材")
        }
        DropdownMenu(textbookMenu, { textbookMenu = false }) {
            textbookLabels.forEach { (id, label) ->
                DropdownMenuItem(text = { Text(label) }, onClick = { onSelectedTextbook(id); textbookMenu = false })
            }
        }
    }
    Button(onClick = onTextbook, enabled = selectedTextbook.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Text("保存教材") }
    OutlinedButton(onClick = { onTheme(!childTheme) }, modifier = Modifier.fillMaxWidth()) { Text(if (childTheme) "切换成人主题" else "切换儿童主题") }
    OutlinedButton(onClick = onPrivacy, modifier = Modifier.fillMaxWidth()) { Text("隐私协议") }
    OutlinedButton(onClick = onTerms, modifier = Modifier.fillMaxWidth()) { Text("用户协议") }
    OutlinedButton(onClick = onLogout, modifier = Modifier.fillMaxWidth()) { Text("退出登录") }
    var confirmDelete by remember { mutableStateOf(false) }
    OutlinedButton(onClick = { confirmDelete = true }, modifier = Modifier.fillMaxWidth(), colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("注销账号") }
    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text("确认注销账户？") },
        text = { Text("注销后将无法登录，学习账户也会停用。") },
        confirmButton = { TextButton(onClick = { confirmDelete = false; onDelete() }) { Text("确认注销") } },
        dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("返回") } },
    )
    if (status.isNotBlank()) Text(status, color = MaterialTheme.colorScheme.primary)
}

@Composable
private fun Field(value: String, onValue: (String) -> Unit, label: String, placeholder: String = "", password: Boolean = false) {
    OutlinedTextField(
        value, onValue, Modifier.fillMaxWidth(), label = { Text(label) },
        placeholder = { if (placeholder.isNotBlank()) Text(placeholder) },
        singleLine = true,
        visualTransformation = if (password) androidx.compose.ui.text.input.PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
    )
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
