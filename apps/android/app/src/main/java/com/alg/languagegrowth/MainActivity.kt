package com.alg.languagegrowth

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
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

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val appearance = getSharedPreferences("appearance", MODE_PRIVATE)
        val account = getSharedPreferences("account", MODE_PRIVATE)
        setContent {
            var childTheme by remember { mutableStateOf(appearance.getBoolean("childTheme", true)) }
            GrowthTheme(childTheme) {
                GrowthApp(
                    account,
                    childTheme,
                    { childTheme = it; appearance.edit().putBoolean("childTheme", it).apply() },
                )
            }
        }
    }
}

private data class Tile(
    val label: String,
    val value: String,
    val emoji: String,
    val tint: Color,
    val wash: Color,
)

/** 底部 4 个 tab 的键集合，与改造前基线一致；图标 / 配色数据见 AppDesign.GrowthNavItems。 */
@Suppress("UNUSED_VARIABLE")
private val tabs = listOf("home", "learn", "achievements", "me")

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
        GrowthBackground {
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
        }
        return
    }

    LaunchedEffect(Unit) {
        if (dashboard == null) runCatching { fetchDashboard() }
            .onFailure { pageStatus = it.message ?: "学习资料加载失败" }
    }

    GrowthBackground {
        Scaffold(
            containerColor = Color.Transparent,
            bottomBar = {
                if (screen == "tabs") GrowthNavBar(tab) { tab = it; pageStatus = "" }
            },
        ) { inset ->
            Column(
                Modifier
                    .fillMaxSize()
                    .padding(inset)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = GrowthDimens.ScreenPad, vertical = 16.dp),
                verticalArrangement = Arrangement.spacedBy(GrowthDimens.CardGap),
            ) {
                if (screen == "legal_privacy" || screen == "legal_terms") {
                    val privacy = screen == "legal_privacy"
                    GrowthPageHeader(
                        if (privacy) "隐私协议" else "用户协议",
                        "请由监护人陪同阅读",
                        if (privacy) "🛡️" else "📄",
                    )
                    GrowthCard(modifier = Modifier.fillMaxWidth()) {
                        GrowthPill("由监护人阅读", GrowthColors.BlueDeep, GrowthColors.BlueWash, emoji = "👨‍👩‍👧")
                        GrowthSectionTitle("条款正文", "📌")
                        Text(
                            if (privacy) "我们仅处理提供学习服务所需的账户资料与学习记录。语音功能按服务配置处理；学习记录用于生成个性化课程进度。你可以在“我”页面申请注销账户。"
                            else "使用本服务时，请由监护人协助未成年人完成账户注册与学习设置。学习建议仅用于辅助学习，能力阶段以服务端记录为准。",
                            style = MaterialTheme.typography.bodyLarge,
                            lineHeight = 28.sp,
                            color = GrowthColors.Ink,
                        )
                    }
                    GrowthSecondaryButton("返回", { screen = "tabs" }, emoji = "↩️")
                } else if (screen == "tabs") {
                    when (tab) {
                        "home" -> GrowthPageHeader("英语成长课堂", "每天一点点，慢慢变厉害 ✨", "🌈")
                        "learn" -> GrowthPageHeader("今天学什么", "跟着老师，慢慢来 🌿", "📖")
                        "achievements" -> GrowthPageHeader("成长成就", "每一步都算数", "🏆")
                        else -> GrowthPageHeader("我的账户", "由监护人协助设置", "👤")
                    }
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
}

/* ------------------------------------------------------------- 登录 / 注册 */

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
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = GrowthDimens.ScreenPad, vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Spacer(Modifier.height(8.dp))
        if (LocalChildTheme.current) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                BuddyMascot(Modifier.size(86.dp))
                Column(Modifier.weight(1f)) {
                    Text("英语成长课堂", style = MaterialTheme.typography.displaySmall, color = GrowthColors.PrimaryDeep)
                    Text(if (register) "创建学习账户" else "登录后继续学习", style = MaterialTheme.typography.bodyLarge, color = GrowthColors.InkSoft)
                    Text("每天一点点，慢慢变厉害 ✨", style = MaterialTheme.typography.bodySmall, color = GrowthColors.InkSoft)
                }
            }
        } else {
            Text("英语成长课堂", style = MaterialTheme.typography.headlineMedium, color = GrowthColors.ForestDeep)
            Text(if (register) "创建学习账户" else "登录后继续学习", style = MaterialTheme.typography.bodyLarge, color = GrowthColors.InkSoft)
        }

        GrowthCard(modifier = Modifier.fillMaxWidth()) {
            Box {
                GrowthSelect(
                    if (official) "服务：官方服务" else "服务：自定义服务器",
                    "🌐",
                    onClick = { onServerMenu(true) },
                )
                DropdownMenu(serverMenu, { onServerMenu(false) }) {
                    DropdownMenuItem(text = { Text("官方服务") }, onClick = { onOfficial(true) })
                    DropdownMenuItem(text = { Text("自定义服务器") }, onClick = { onOfficial(false) })
                }
            }
            if (!official) GrowthTextField(
                custom, onCustom, "服务器地址",
                placeholder = "https://example.com/api/v1", leadingEmoji = "🔗",
            )
            GrowthTextField(email, onEmail, "邮箱", leadingEmoji = "📧")
            if (register) GrowthTextField(displayName, onName, "学习者昵称（可选）", leadingEmoji = "😊")
            GrowthTextField(password, onPassword, "密码", password = true, leadingEmoji = "🔒")
            if (register) {
                if (captchaSvg.isNotBlank()) {
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .height(72.dp)
                            .clip(GrowthShapes.CardSmall)
                            .background(GrowthColors.Cream)
                            .border(1.5.dp, GrowthColors.Outline, GrowthShapes.CardSmall),
                        contentAlignment = Alignment.Center,
                    ) {
                        AndroidView(
                            factory = { WebView(it).apply { settings.javaScriptEnabled = false } },
                            update = { it.loadData(Base64Svg(captchaSvg), "image/svg+xml", "UTF-8") },
                            modifier = Modifier.fillMaxWidth().height(70.dp),
                        )
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    GrowthTextField(
                        captchaCode, onCaptcha, "4 位图片验证码",
                        modifier = Modifier.weight(1f), leadingEmoji = "🔢",
                    )
                    GrowthTextButton("换一张", onRefreshCaptcha, emoji = "🔄")
                }
                if (captchaStatus.isNotBlank()) GrowthStatusPill(captchaStatus)
                Text("密码至少 6 位，请避免使用连续数字或重复数字。", style = MaterialTheme.typography.bodySmall, color = GrowthColors.InkSoft)
            }
            GrowthPrimaryButton(
                if (register) "注册" else "登录",
                onSubmit,
                emoji = if (register) "🎉" else "🚀",
                enabled = email.contains("@") && password.isNotBlank(),
                busy = busy,
            )
        }
        GrowthTextButton(
            if (register) "已有账户？返回登录" else "创建新账户",
            onRegisterToggle,
            modifier = Modifier.fillMaxWidth(),
            emoji = if (register) "↩️" else "✨",
        )
        if (pageStatus.isNotBlank()) GrowthStatusPill(pageStatus)
        Spacer(Modifier.height(24.dp))
    }
}

private fun Base64Svg(value: String): String = try {
    String(android.util.Base64.decode(value, android.util.Base64.DEFAULT), Charsets.UTF_8)
} catch (_: Exception) { "" }

/* ------------------------------------------------------------------- 首页 */

@Composable
private fun HomeScreen(data: JSONObject?, childTheme: Boolean, status: String, onStart: () -> Unit, onRefresh: () -> Unit) {
    val user = data?.optJSONObject("user")
    val learner = data?.optJSONObject("learner")
    val stats = data?.optJSONObject("stats")
    val name = learner?.optString("displayName").orEmpty().ifBlank { user?.optString("displayName").orEmpty() }
    val child = LocalChildTheme.current

    // 问候横幅：吉祥物 + 大号问候 + 连续学习天数
    GrowthCard(
        modifier = Modifier.fillMaxWidth(),
        fill = GrowthColors.MintWash,
        outline = GrowthColors.Mint.copy(alpha = 0.22f),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (child) BuddyMascot(Modifier.size(78.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("你好，${name.ifBlank { "学习者" }} 👋", style = MaterialTheme.typography.headlineMedium, color = GrowthColors.MintDeep)
                Text("今天也一起慢慢学一点吧 🌿", style = MaterialTheme.typography.bodyMedium, color = GrowthColors.InkSoft)
                GrowthPill(
                    "连续学习 ${stats?.optInt("streak", 0) ?: 0} 天",
                    GrowthColors.MintDeep,
                    GrowthColors.Surface,
                    emoji = "🔥",
                )
            }
        }
        Text(user?.optString("email").orEmpty(), style = MaterialTheme.typography.bodySmall, color = GrowthColors.InkSoft)
    }

    // 学习进度：2×2 彩色统计贴纸
    GrowthCard(modifier = Modifier.fillMaxWidth()) {
        GrowthSectionTitle("我的学习进度", "📊")
        val mapping = data?.optJSONObject("textbook")
        val tiles = listOf(
            Tile("当前级别", learner?.optString("entryLevel")?.uppercase() ?: "PRE-A1", "🌱", GrowthColors.PrimaryDeep, GrowthColors.PrimaryWash),
            Tile("教材", "${mapping?.optString("publisher")?.takeIf { it != "null" } ?: "尚未选择"} ${mapping?.optString("grade").orEmpty()}", "📚", GrowthColors.BlueDeep, GrowthColors.BlueWash),
            Tile("已学词汇", (stats?.optInt("usedWords", 0) ?: 0).toString(), "🧩", GrowthColors.GrapeDeep, GrowthColors.GrapeWash),
            Tile("连续学习", "${stats?.optInt("streak", 0) ?: 0} 天", "🔥", GrowthColors.MintDeep, GrowthColors.MintWash),
        )
        tiles.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { tile ->
                    GrowthStatTile(tile.value, tile.label, tile.emoji, tile.tint, tile.wash, Modifier.weight(1f))
                }
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }

    // 七项能力：彩色能力卡 + 4 段胶囊进度
    GrowthSectionTitle("七项能力", "🌈")
    val abilities = data?.optJSONArray("abilities")
    val labels = listOf("听力", "语音", "词汇", "语法", "口语", "交流", "学校")
    val emojis = listOf("👂", "🗣️", "🧠", "📐", "💬", "🤝", "🏫")
    val tints = listOf(
        GrowthColors.BlueDeep, GrowthColors.PrimaryDeep, GrowthColors.GrapeDeep, GrowthColors.MintDeep,
        GrowthColors.BlueDeep, GrowthColors.GrapeDeep, GrowthColors.SunDeep,
    )
    val washes = listOf(
        GrowthColors.BlueWash, GrowthColors.PrimaryWash, GrowthColors.GrapeWash, GrowthColors.MintWash,
        GrowthColors.BlueWash, GrowthColors.GrapeWash, GrowthColors.SunWash,
    )
    labels.forEachIndexed { i, label ->
        val stageObj = (0 until (abilities?.length() ?: 0)).mapNotNull { abilities?.optJSONObject(it) }
            .firstOrNull { it.optString("label") == label }
        val stageValue = stageObj?.optInt("stage", 0) ?: 0
        val calibrated = stageObj?.optBoolean("calibrated", false) ?: false
        val stageText = when (stageValue) { 0 -> "待开始"; 1 -> "正在接触"; 2 -> "练习中"; 3 -> "持续巩固"; else -> "阶段稳定" }
        val stageLabel = if (calibrated) stageText else if (stageValue == 0) "待开始" else "$stageText*"
        val tint = if (child) tints[i] else GrowthColors.ForestDeep
        val wash = if (child) washes[i] else GrowthColors.ForestWash
        GrowthCard(modifier = Modifier.fillMaxWidth(), contentPadding = GrowthDimens.CardPadSmall) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Box(
                    Modifier.size(46.dp).clip(GrowthShapes.Pill).background(wash),
                    contentAlignment = Alignment.Center,
                ) { Text(emojis[i], fontSize = 22.sp) }
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(label, style = MaterialTheme.typography.titleMedium, color = GrowthColors.Ink)
                        Spacer(Modifier.weight(1f))
                        GrowthPill(stageLabel, tint, wash)
                    }
                    SegmentedProgress(stageValue, tint, Modifier.fillMaxWidth())
                }
            }
        }
    }

    GrowthPrimaryButton(if (childTheme) "开始今天的学习" else "开始学习", onStart, emoji = "🚀")
    GrowthSecondaryButton("刷新学习进度", onRefresh, emoji = "🔄")
    if (status.isNotBlank()) GrowthStatusPill(status)
    Text(data?.optString("calibrationNotice").orEmpty(), style = MaterialTheme.typography.bodySmall, color = GrowthColors.InkSoft)
}

/* -------------------------------------------------------------- 今天学什么 */

@Composable
private fun LearnScreen(lessonText: String, busy: Boolean, status: String, onStart: () -> Unit) {
    GrowthCard(
        modifier = Modifier.fillMaxWidth(),
        fill = GrowthColors.BlueWash,
        outline = GrowthColors.Blue.copy(alpha = 0.20f),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("🧑‍🏫", fontSize = 30.sp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("跟着老师的节奏，完成一小段练习。", style = MaterialTheme.typography.titleMedium, color = GrowthColors.Ink)
                Text("不着急，慢慢来就好 🌿", style = MaterialTheme.typography.bodySmall, color = GrowthColors.InkSoft)
            }
        }
    }
    GrowthPrimaryButton(
        if (lessonText.isBlank()) "开始学习" else "再来一节",
        onStart,
        emoji = "✨",
        enabled = !busy,
        busy = busy,
    )
    if (lessonText.isNotBlank()) {
        GrowthCard(modifier = Modifier.fillMaxWidth()) {
            GrowthSectionTitle("今天的课堂", "📖")
            lessonText.split("\n\n").filter { it.isNotBlank() }.forEachIndexed { index, part ->
                GrowthSpeechBubble(
                    text = part,
                    tint = if (index == 0) GrowthColors.PrimaryDeep else GrowthColors.BlueDeep,
                    wash = if (index == 0) GrowthColors.PrimaryWash else GrowthColors.BlueWash,
                    emoji = if (index == 0) "🌟" else "💬",
                    big = index == 0,
                )
            }
            Text("准备好后，可以跟着老师读一读或回答问题。", style = MaterialTheme.typography.bodyMedium, color = GrowthColors.InkSoft)
        }
    } else {
        GrowthCard(
            modifier = Modifier.fillMaxWidth(),
            fill = GrowthColors.SunWash,
            outline = GrowthColors.Sun.copy(alpha = 0.28f),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                if (LocalChildTheme.current) BuddyMascot(Modifier.size(76.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("课堂还没开始哦", style = MaterialTheme.typography.titleLarge, color = GrowthColors.SunDeep)
                    Text("课程会根据你的学习进度调整。", style = MaterialTheme.typography.bodyMedium, color = GrowthColors.InkSoft)
                }
            }
        }
    }
    if (status.isNotBlank()) GrowthStatusPill(status)
}

/* -------------------------------------------------------------- 成长成就 */

@Composable
private fun AchievementScreen(data: JSONObject?) {
    val stats = data?.optJSONObject("stats")
    GrowthCard(
        modifier = Modifier.fillMaxWidth(),
        fill = GrowthColors.SunWash,
        outline = GrowthColors.Sun.copy(alpha = 0.28f),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("🏆", fontSize = 38.sp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("每一步练习，都会成为成长的证据。", style = MaterialTheme.typography.titleMedium, color = GrowthColors.SunDeep)
                Text("慢慢积累，就会看到变化 ✨", style = MaterialTheme.typography.bodySmall, color = GrowthColors.InkSoft)
            }
        }
    }
    val values = listOf(
        "会默写的词" to (stats?.optInt("dictationWords", 0) ?: 0).toString(),
        "能听懂的词" to (stats?.optInt("understoodWords", 0) ?: 0).toString(),
        "能使用的词" to (stats?.optInt("usedWords", 0) ?: 0).toString(),
        "掌握的语法类别" to (stats?.optInt("grammarCategories", 0) ?: 0).toString(),
        "发音标准词数" to (stats?.optInt("pronunciationWords", 0) ?: 0).toString(),
        "口语能力评分" to (stats?.optDouble("speakingScore", 0.0) ?: 0.0).toString(),
    )
    val emojis = listOf("✍️", "👂", "💬", "📐", "🗣️", "⭐")
    val tints = listOf(
        GrowthColors.PrimaryDeep, GrowthColors.BlueDeep, GrowthColors.GrapeDeep,
        GrowthColors.MintDeep, GrowthColors.BlueDeep, GrowthColors.SunDeep,
    )
    val washes = listOf(
        GrowthColors.PrimaryWash, GrowthColors.BlueWash, GrowthColors.GrapeWash,
        GrowthColors.MintWash, GrowthColors.BlueWash, GrowthColors.SunWash,
    )
    values.chunked(2).forEachIndexed { rowIndex, row ->
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            row.forEachIndexed { colIndex, pair ->
                val i = rowIndex * 2 + colIndex
                GrowthStatTile(pair.second, pair.first, emojis[i], tints[i], washes[i], Modifier.weight(1f))
            }
            if (row.size == 1) Spacer(Modifier.weight(1f))
        }
    }
    GrowthSectionTitle("学习勋章", "🏅")
    val achievements = data?.optJSONObject("achievements")
    listOf(
        "百词斩" to "hundredWords", "连续学习 10 天" to "streak10",
        "连续学习 20 天" to "streak20", "连续学习 30 天" to "streak30",
        "连续学习 50 天" to "streak50", "连续学习 100 天" to "streak100",
    ).chunked(2).forEach { row ->
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            row.forEach { (label, key) ->
                val earned = achievements?.optBoolean(key, false) ?: false
                GrowthCard(
                    modifier = Modifier.weight(1f),
                    fill = if (earned) GrowthColors.SunWash else GrowthColors.Surface,
                    outline = if (earned) GrowthColors.Sun.copy(alpha = 0.35f) else GrowthColors.Outline,
                    contentPadding = GrowthDimens.CardPadSmall,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        MedalBadge(earned, badgeSize = 44.dp)
                        Column(Modifier.weight(1f)) {
                            Text(label, style = MaterialTheme.typography.titleSmall, color = GrowthColors.Ink)
                            Text(
                                if (earned) "已获得" else "继续加油",
                                style = MaterialTheme.typography.bodySmall,
                                color = if (earned) GrowthColors.SunDeep else GrowthColors.InkSoft,
                            )
                        }
                    }
                }
            }
            if (row.size == 1) Spacer(Modifier.weight(1f))
        }
    }
}

/* ------------------------------------------------------- 我的账户（家长向） */

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
    var confirmDelete by remember { mutableStateOf(false) }
    val textbooks = data?.optJSONArray("textbooks")
    val textbookLabels = (0 until (textbooks?.length() ?: 0)).mapNotNull { index ->
        textbooks?.optJSONObject(index)?.let { it.optString("id") to "${it.optString("publisher")} · ${it.optInt("publicationYear")} · ${it.optString("grade")} ${it.optString("title")}" }
    }

    GrowthCard(modifier = Modifier.fillMaxWidth()) {
        GrowthSectionTitle("个人资料", "👤")
        Text(user?.optString("email").orEmpty(), style = MaterialTheme.typography.bodyMedium, color = GrowthColors.InkSoft)
        GrowthTextField(name, onName, "个人资料名称", leadingEmoji = "✏️")
        GrowthPrimaryButton("保存资料", onSaveProfile, emoji = "💾")
    }

    GrowthCard(modifier = Modifier.fillMaxWidth()) {
        GrowthSectionTitle("选择头像", "🎨")
        AvatarPicker(
            current = avatar,
            dashboard = data,
            onSelect = onAvatar,
        )
    }

    GrowthCard(modifier = Modifier.fillMaxWidth()) {
        GrowthSectionTitle("邮箱验证", "✉️")
        GrowthPill(
            "邮箱${if (emailVerified) "已验证" else "尚未验证"}",
            if (emailVerified) GrowthColors.MintDeep else GrowthColors.PrimaryDeep,
            if (emailVerified) GrowthColors.MintWash else GrowthColors.PrimaryWash,
            emoji = if (emailVerified) "✅" else "⚠️",
        )
        if (!emailVerified) {
            Text("只有验证邮箱后，才能使用邮箱找回密码。", style = MaterialTheme.typography.bodySmall, color = GrowthColors.InkSoft)
            GrowthSecondaryButton("发送验证邮件", onSendVerification, emoji = "📤")
            GrowthTextField(code, onCode, "6 位邮箱验证码", leadingEmoji = "🔢")
            GrowthPrimaryButton("验证邮箱", onVerify, enabled = code.length == 6, emoji = "✅")
        }
    }

    GrowthCard(modifier = Modifier.fillMaxWidth()) {
        GrowthSectionTitle("修改密码", "🔒")
        GrowthTextField(currentPassword, onCurrentPassword, "当前密码", password = true, leadingEmoji = "🔑")
        GrowthTextField(newPassword, onNewPassword, "新密码（至少 6 位）", password = true, leadingEmoji = "🆕")
        GrowthSecondaryButton("更新密码", onPassword, emoji = "🔄")
    }

    GrowthCard(modifier = Modifier.fillMaxWidth()) {
        GrowthSectionTitle("选择教材", "📚")
        Box {
            GrowthSelect(
                textbookLabels.firstOrNull { it.first == selectedTextbook }?.second ?: "选择教材",
                "📖",
                onClick = { textbookMenu = true },
            )
            DropdownMenu(textbookMenu, { textbookMenu = false }) {
                textbookLabels.forEach { (id, label) ->
                    DropdownMenuItem(text = { Text(label) }, onClick = { onSelectedTextbook(id); textbookMenu = false })
                }
            }
        }
        GrowthPrimaryButton("保存教材", onTextbook, enabled = selectedTextbook.isNotBlank(), emoji = "📌")
    }

    GrowthCard(modifier = Modifier.fillMaxWidth()) {
        GrowthSectionTitle("偏好与协议", "⚙️")
        GrowthSecondaryButton(
            if (childTheme) "切换成人主题" else "切换儿童主题",
            { onTheme(!childTheme) },
            emoji = if (childTheme) "🌿" else "🌈",
        )
        GrowthLinkRow("隐私协议", "🛡️", onPrivacy)
        GrowthLinkRow("用户协议", "📄", onTerms)
    }

    GrowthCard(modifier = Modifier.fillMaxWidth()) {
        GrowthSectionTitle("账户", "👋")
        GrowthLinkRow("退出登录", "🚪", onLogout)
        GrowthLinkRow("注销账号", "⚠️", { confirmDelete = true }, danger = true)
    }

    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        containerColor = GrowthColors.Surface,
        shape = GrowthShapes.Card,
        titleContentColor = GrowthColors.Ink,
        textContentColor = GrowthColors.InkSoft,
        title = { Text("确认注销账户？", style = MaterialTheme.typography.headlineSmall) },
        text = { Text("注销后将无法登录，学习账户也会停用。", style = MaterialTheme.typography.bodyLarge) },
        confirmButton = {
            TextButton(onClick = { confirmDelete = false; onDelete() }, modifier = Modifier.height(48.dp)) {
                Text("确认注销", color = GrowthColors.Danger, style = MaterialTheme.typography.titleMedium)
            }
        },
        dismissButton = {
            TextButton(onClick = { confirmDelete = false }, modifier = Modifier.height(48.dp)) {
                Text("返回", style = MaterialTheme.typography.titleMedium)
            }
        },
    )
    if (status.isNotBlank()) GrowthStatusPill(status)
}

/* ------------------------------------------------------------- 网络层（未改） */

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
