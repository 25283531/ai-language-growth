package com.alg.languagegrowth

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.util.Base64
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
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
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
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
    private var recorder: MediaRecorder? = null
    private var recordingPath: String? = null
    private var lastRecordingPath: String? = null
    private var playback: MediaPlayer? = null
    private var audioPermissionGranted by mutableStateOf(false)
    private val audioPermissionRequest = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        audioPermissionGranted = granted
    }

    fun hasAudioPermission(): Boolean = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    fun requestAudioPermission() {
        if (hasAudioPermission()) audioPermissionGranted = true else audioPermissionRequest.launch(Manifest.permission.RECORD_AUDIO)
    }

    fun startRecording(): String {
        val file = java.io.File(cacheDir, "classroom-${System.currentTimeMillis()}.m4a")
        val created = if (android.os.Build.VERSION.SDK_INT >= 31) MediaRecorder(this) else @Suppress("DEPRECATION") MediaRecorder()
        created.setAudioSource(MediaRecorder.AudioSource.MIC)
        created.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        created.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        created.setOutputFile(file.absolutePath)
        created.prepare(); created.start()
        recorder = created; recordingPath = file.absolutePath
        return file.absolutePath
    }

    fun stopRecording(): Pair<String, Long> {
        val current = recorder ?: error("当前没有录音")
        val path = recordingPath ?: error("录音文件不存在")
        current.stop(); current.release(); recorder = null; recordingPath = null
        lastRecordingPath = path
        return path to java.io.File(path).length()
    }

    /** 回放只读手机本地缓存文件；服务端不保存录音。 */
    fun playLastRecording(): Boolean {
        val path = lastRecordingPath ?: return false
        if (!java.io.File(path).exists()) return false
        playback?.runCatching { release() }
        playback = MediaPlayer().apply {
            setDataSource(path)
            prepare()
            start()
            setOnCompletionListener { player -> player.release(); if (playback === player) playback = null }
        }
        return true
    }

    fun hasLocalRecording(): Boolean =
        lastRecordingPath?.let { java.io.File(it).exists() } == true

    override fun onDestroy() {
        recorder?.runCatching { stop() }; recorder?.release(); recorder = null
        playback?.runCatching { release() }; playback = null
        super.onDestroy()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val appearance = getSharedPreferences("appearance", MODE_PRIVATE)
        val account = getSharedPreferences("account", MODE_PRIVATE)
        setContent {
            var childTheme by remember { mutableStateOf(appearance.getBoolean("childTheme", true)) }
            GrowthTheme(childTheme) {
                GrowthApp(
                    this@MainActivity,
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

private fun JSONObject.jsonObjects(key: String): List<JSONObject> {
    val array = optJSONArray(key) ?: return emptyList()
    return (0 until array.length()).mapNotNull { array.optJSONObject(it) }
}

private fun JSONObject?.stringItems(key: String): List<String> {
    val array = this?.optJSONArray(key) ?: return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        array.optString(index).takeIf { it.isNotBlank() }
    }
}

private fun errorUnitLabel(unit: String): String = when (unit) {
    "syllable" -> "音节"
    "phoneme" -> "音素"
    "word" -> "单词"
    "pitch" -> "音高"
    "rhythm" -> "节奏"
    else -> "发音"
}

/** 底部 4 个 tab 的键集合，与改造前基线一致；图标 / 配色数据见 AppDesign.GrowthNavItems。 */
@Suppress("UNUSED_VARIABLE")
private val tabs = listOf("home", "learn", "achievements", "me")

@Composable
private fun GrowthApp(
    activity: MainActivity,
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
    var weeklyReport by remember { mutableStateOf<JSONObject?>(null) }
    var weeklyError by remember { mutableStateOf("") }
    var weeklyRefreshing by remember { mutableStateOf(false) }
    var weeklyStatus by remember { mutableStateOf("") }
    // 家长区是本次运行期内的独立解锁态，不复用 childTheme（主题不等于角色）。
    var parentUnlocked by remember { mutableStateOf(false) }
    var lessonSessionId by remember { mutableStateOf("") }
    var directive by remember { mutableStateOf<JSONObject?>(null) }
    var finishResult by remember { mutableStateOf<JSONObject?>(null) }
    var responseText by remember { mutableStateOf("") }
    var recording by remember { mutableStateOf(false) }
    var recordingSaved by remember { mutableStateOf(false) }
    var recordingStartedAt by remember { mutableStateOf(0L) }
    var asrReservationId by remember { mutableStateOf("") }
    var speechBusy by remember { mutableStateOf(false) }
    var speechStatus by remember { mutableStateOf("") }
    var lessonSpeech by remember { mutableStateOf<JSONObject?>(null) }
    val teacherSpeech = remember(activity) { TeacherSpeechController(activity.cacheDir) }

    DisposableEffect(activity, teacherSpeech) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_STOP) {
                teacherSpeech.stop()
                speechBusy = false
                speechStatus = "语音已停止，可返回课堂后重试"
            }
        }
        activity.lifecycle.addObserver(observer)
        onDispose { activity.lifecycle.removeObserver(observer); teacherSpeech.close() }
    }
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

    fun playTeacher(replay: Boolean = false) {
        val current = directive ?: return
        teacherSpeech.play(base(), token().orEmpty(), learnerId, current, lessonSpeech, replay) { active, message ->
            speechBusy = active
            speechStatus = message
        }
    }

    LaunchedEffect(loggedIn, learnerId, tab, screen, directive, finishResult) {
        teacherSpeech.stop()
        speechBusy = false
        speechStatus = ""
        if (loggedIn && learnerId.isNotBlank() && tab == "learn" && screen == "tabs" && directive != null && finishResult == null) {
            playTeacher()
        }
    }

    suspend fun fetchWeeklyReport() {
        if (learnerId.isBlank()) return
        val result = withContext(Dispatchers.IO) {
            http(base(), "/learners/${learnerId}/reports/weekly", "GET", token = token())
        }
        weeklyReport = result
        weeklyError = ""
    }

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
        try {
            fetchWeeklyReport()
        } catch (e: Exception) {
            weeklyError = e.message ?: "本周周报暂时无法加载"
        }
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
                lessonSessionId = response.optString("lessonSessionId")
                lessonSpeech = response.optJSONObject("speech")
                directive = response.optJSONObject("directive")
                finishResult = null; responseText = ""; recordingSaved = false
                tab = "learn"
                pageStatus = ""
            } catch (e: Exception) {
                pageStatus = e.message ?: "暂时无法开始课堂"
            } finally {
                busy = false
            }
        }
    }

    suspend fun submitTurn(audioBase64: String?, audioContentType: String?, durationMs: Long) {
        if (lessonSessionId.isBlank()) { pageStatus = "请先开始课堂"; return }
        busy = true
        try {
            // 录音只在本次 JSON 请求内传给服务端；服务端不落盘，手机本地保留供回放。
            val body = JSONObject().put("learnerId", learnerId).put("idempotencyKey", "android-${System.currentTimeMillis()}-${(0..99999).random()}").put("clientTimestamp", java.time.Instant.now().toString())
                .put("response", JSONObject()
                    .put("text", responseText.trim().ifBlank { JSONObject.NULL })
                    .put("audioRef", JSONObject.NULL)
                    .put("audioBase64", audioBase64 ?: JSONObject.NULL)
                    .put("audioContentType", audioContentType ?: JSONObject.NULL)
                    .put("audioDurationMs", if (audioBase64 == null) JSONObject.NULL else durationMs)
                    .put("selectedImageId", JSONObject.NULL)
                    .put("requestedSlower", false)
                    .put("requestedRepeat", false)
                    .put("freeUtterance", JSONObject.NULL))
            val headers = if (audioBase64 != null) mapOf("X-Speech-Quota-Reservation" to asrReservationId, "X-Learner-Id" to learnerId) else emptyMap()
            val result = withContext(Dispatchers.IO) { http(base(), "/lessons/${lessonSessionId}/turn", "POST", body, token(), headers) }
            asrReservationId = ""
            lessonSpeech = result.optJSONObject("speech")
            directive = result.optJSONObject("directive"); responseText = ""
            // 降级原因只用于服务端排障，不把内部供应商/协议细节展示给孩子。
            pageStatus = ""
        } catch (e: Exception) {
            if (audioBase64 != null && asrReservationId.isNotBlank()) {
                runCatching { withContext(Dispatchers.IO) { http(base(), "/speech/quota/release", "POST", JSONObject().put("reservationId", asrReservationId), token()) } }
                asrReservationId = ""
            }
            pageStatus = e.message ?: "提交失败"
        } finally { busy = false }
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

    // 切回「我」时重新拉取本周周报：结课/刷新学习进度后不必重启应用。
    LaunchedEffect(tab, loggedIn, learnerId) {
        if (loggedIn && tab == "me" && learnerId.isNotBlank()) {
            weeklyRefreshing = true
            weeklyStatus = "正在刷新周报…"
            try {
                fetchWeeklyReport()
                weeklyStatus = "已更新本周记录"
            } catch (e: Exception) {
                weeklyError = e.message ?: "本周周报暂时无法加载"
                weeklyStatus = "周报暂时无法刷新"
            } finally {
                weeklyRefreshing = false
            }
        }
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
                            if (privacy) "我们仅处理提供学习服务所需的账户资料与学习记录。孩子的录音文件只保存在本机，供课后回放；服务端不保存录音文件。为完成当次语音识别和发音评估，音频会在本次请求内转发给配置的语音服务商，服务商不得将其用于模型训练。学习记录只保存识别文本、评分与学习证据，不保存原始录音。你可以在“我”页面申请注销账户。"
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
                        "learn" -> LearnScreen(
                            directive, finishResult, responseText, recording, recordingSaved, busy, pageStatus,
                            onStart = ::startSession,
                            speechBusy = speechBusy,
                            speechStatus = speechStatus,
                            onReplay = { playTeacher(true) },
                            onPlayRecording = { if (!activity.playLastRecording()) pageStatus = "还没有可回放的录音" },
                            onText = { responseText = it },
                            onRecord = {
                                teacherSpeech.stop(clearAudio = false)
                                speechBusy = false
                                scope.launch {
                                    if (!recording) {
                                        if (!activity.hasAudioPermission()) {
                                            activity.requestAudioPermission()
                                            pageStatus = "请允许麦克风权限后再次点击录音"
                                        } else {
                                            try {
                                                activity.startRecording()
                                                recordingStartedAt = System.currentTimeMillis()
                                                recording = true
                                            } catch (e: Exception) { pageStatus = e.message ?: "无法开始录音" }
                                        }
                                    } else {
                                        try {
                                            val (path, _) = activity.stopRecording()
                                            recording = false
                                            recordingSaved = true
                                            val durationMs = System.currentTimeMillis() - recordingStartedAt
                                            val seconds = (durationMs / 1000.0).coerceIn(1.0, 120.0)
                                            val reservation = withContext(Dispatchers.IO) {
                                                http(base(), "/speech/quota/reserve", "POST", JSONObject()
                                                    .put("learnerId", learnerId)
                                                    .put("serviceKind", "asr")
                                                    .put("seconds", seconds)
                                                    .put("idempotencyKey", "android-asr-${System.currentTimeMillis()}"), token())
                                            }
                                            asrReservationId = reservation.optString("reservationId")
                                            // 录音只读手机本地缓存；以一次性 base64 随课堂回合提交，服务端不落盘。
                                            val encoded = withContext(Dispatchers.IO) {
                                                Base64.encodeToString(java.io.File(path).readBytes(), Base64.NO_WRAP)
                                            }
                                            responseText = ""
                                            submitTurn(encoded, "audio/mp4", durationMs)
                                        } catch (e: Exception) {
                                            recording = false
                                            val reservationId = asrReservationId
                                            asrReservationId = ""
                                            if (reservationId.isNotBlank()) {
                                                runCatching {
                                                    withContext(Dispatchers.IO) {
                                                        http(base(), "/speech/quota/release", "POST", JSONObject().put("reservationId", reservationId), token())
                                                    }
                                                }
                                            }
                                            pageStatus = e.message ?: "录音提交失败"
                                        }
                                    }
                                }
                            },
                            onSubmit = { teacherSpeech.stop(clearAudio = false); scope.launch { submitTurn(null, null, 0) } },
                            onFinish = { scope.launch { try { finishResult = withContext(Dispatchers.IO) { http(base(), "/lessons/${lessonSessionId}/finish", "POST", JSONObject().put("learnerId", learnerId), token()) } } catch (e: Exception) { pageStatus = e.message ?: "结课失败" } } },
                        )
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
                                        parentUnlocked = false
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
                            onPrivacy = {
                                if (parentUnlocked) screen = "legal_privacy" else pageStatus = "请先完成家长验证"
                            },
                            onTerms = { screen = "legal_terms" },
                            onLogout = {
                                parentUnlocked = false
                                account.edit().remove("token").apply()
                                loggedIn = false
                                register = false
                                pageStatus = ""
                            },
                            onDelete = {
                                if (!parentUnlocked) {
                                    pageStatus = "请先完成家长验证"
                                } else {
                                    scope.launch {
                                        busy = true
                                        try {
                                            withContext(Dispatchers.IO) { http(base(), "/user/account", "DELETE", token = token()) }
                                            parentUnlocked = false
                                            account.edit().remove("token").apply()
                                            loggedIn = false
                                            pageStatus = "账户已注销"
                                        } catch (e: Exception) { pageStatus = e.message ?: "注销失败" } finally { busy = false }
                                    }
                                }
                            },
                            weekly = weeklyReport,
                            weeklyError = weeklyError,
                            weeklyRefreshing = weeklyRefreshing,
                            weeklyStatus = weeklyStatus,
                            onRefreshWeekly = {
                                if (!weeklyRefreshing) scope.launch {
                                    weeklyRefreshing = true
                                    weeklyStatus = "正在刷新周报…"
                                    try {
                                        fetchWeeklyReport()
                                        weeklyStatus = "周报已刷新"
                                    } catch (e: Exception) {
                                        weeklyError = e.message ?: "周报刷新失败"
                                        weeklyStatus = "周报暂时无法刷新"
                                    } finally {
                                        weeklyRefreshing = false
                                    }
                                }
                            },
                            parentUnlocked = parentUnlocked,
                            onParentUnlocked = { parentUnlocked = true },
                            onLockParent = { parentUnlocked = false },
                            onPayment = { pageStatus = "支付入口尚未开放，本次不会扣款" },
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
private fun LearnScreen(
    directive: JSONObject?, finish: JSONObject?, responseText: String, recording: Boolean,
    recordingSaved: Boolean, busy: Boolean, status: String, onStart: () -> Unit, onText: (String) -> Unit,
    onRecord: () -> Unit, onSubmit: () -> Unit, onFinish: () -> Unit,
    speechBusy: Boolean, speechStatus: String, onReplay: () -> Unit, onPlayRecording: () -> Unit,
) {
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
    GrowthPrimaryButton(if (directive == null) "开始学习" else "再来一节", onStart, emoji = "✨", enabled = !busy, busy = busy)
    if (directive != null) {
        GrowthCard(modifier = Modifier.fillMaxWidth()) {
            GrowthSectionTitle("课堂指令", "📖")
            PronunciationCard(
                directive = directive,
                speaking = speechBusy && speechStatus.contains("正在说话"),
            )
            Text(directive.optString("teacherUtterance"), style = MaterialTheme.typography.titleLarge, color = GrowthColors.Ink)
            if (directive.optString("expectedResponse") == "tap_image") Text("此指令没有图片选项配置，暂不能点选图片；请使用文本回应。", color = GrowthColors.InkSoft)
            if (speechStatus.isNotBlank()) Text(speechStatus, color = GrowthColors.InkSoft)
            GrowthSecondaryButton(if (speechBusy) "老师正在说话" else "再听一次", onReplay, enabled = !speechBusy && !recording && !busy)
            GrowthTextField(responseText, onText, "尝试拼写一下", leadingEmoji = "✍️")
            GrowthSecondaryButton(if (recording) "停止并提交录音" else "开始录音", onRecord, emoji = "🎙️", enabled = !busy)
            if (recordingSaved) GrowthSecondaryButton("回放我的录音", onPlayRecording, emoji = "🔊", enabled = !recording && !busy)
            GrowthPrimaryButton("提交回应", onSubmit, emoji = "📨", enabled = !busy)
            GrowthSecondaryButton("结课", onFinish, emoji = "🏁", enabled = !busy)
        }
        finish?.let {
            GrowthCard(
                modifier = Modifier.fillMaxWidth(),
                fill = GrowthColors.SunWash,
                outline = GrowthColors.Sun.copy(alpha = 0.28f),
            ) {
                Text("这节课完成啦！", style = MaterialTheme.typography.headlineMedium, color = GrowthColors.Ink)
                Text("今天又练习了一点，休息一下，下次继续 🌿", color = GrowthColors.InkSoft)
            }
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

/**
 * 儿童发音卡：只展示可读的字母、IPA 与跟读提示。
 *
 * 服务端的 pronunciationUnits.kind（word/syllable/phoneme）是内部枚举，
 * 不直接呈现给孩子；这里把单词拆成单个字母块，避免出现 “syllable” 这类术语。
 * 当前教师语音是一整段连续音频，没有单词级时间戳，因此朗读时以整张
 * 发音卡进入“正在朗读”状态为准，不伪造逐字母跳动的时间轴。
 */
@Composable
private fun PronunciationCard(directive: JSONObject, speaking: Boolean) {
    val targetWords = directive.optJSONArray("targetWords")
    val word = (0 until (targetWords?.length() ?: 0))
        .mapNotNull { index -> targetWords?.optString(index)?.trim()?.takeIf { it.isNotBlank() } }
        .firstOrNull()
        ?: directive.optString("demonstrationText").trim().takeUnless { it.isBlank() || it == "null" }
        ?: return
    val ipa = WordPhonics.of(word)
    val displayWord = word.trim().trim('.', ',', '!', '?', ';', ':', '"')
    val letters = displayWord
        .filter { it.isLetter() || it == '\'' || it == '-' }
        .take(14)
        .map { it.toString() }
    val units = directive.optJSONArray("pronunciationUnits")
    val focusTexts = (0 until (units?.length() ?: 0)).mapNotNull { index ->
        units?.optJSONObject(index)
            ?.takeIf { it.optBoolean("isFocus", false) }
            ?.optString("text")
            ?.lowercase()
            ?.filter { it.isLetter() }
            ?.takeIf { it.isNotBlank() }
    }
    // 服务端只给出音节级重点；把它映射到对应字母，孩子看到的是“哪几个字母要多练”。
    val focusIndexes = mutableSetOf<Int>()
    var searchFrom = 0
    focusTexts.forEach { focus ->
        val at = displayWord.lowercase().indexOf(focus, searchFrom)
        if (at >= 0) {
            (at until at + focus.length).forEach { focusIndexes.add(it) }
            searchFrom = at + focus.length
        }
    }

    GrowthCard(
        modifier = Modifier.fillMaxWidth(),
        fill = if (speaking) GrowthColors.PrimaryWash else GrowthColors.SunWash,
        outline = (if (speaking) GrowthColors.Primary else GrowthColors.Sun).copy(alpha = 0.30f),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            GrowthSectionTitle("发音卡", "🔤")
            Spacer(Modifier.weight(1f))
            GrowthPill(
                if (speaking) "正在朗读" else "跟读",
                if (speaking) GrowthColors.PrimaryDeep else GrowthColors.SunDeep,
                if (speaking) GrowthColors.PrimaryWash else GrowthColors.SunWash,
                emoji = if (speaking) "🔊" else "👂",
            )
        }
        Text(word, style = MaterialTheme.typography.displayMedium, color = GrowthColors.Ink)
        if (ipa.isNotBlank()) {
            Text(ipa, style = MaterialTheme.typography.headlineMedium, color = GrowthColors.BlueDeep)
        }
        if (letters.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                letters.forEachIndexed { index, letter ->
                    val focus = index in focusIndexes
                    val tint = when {
                        focus -> GrowthColors.SunDeep
                        speaking -> GrowthColors.PrimaryDeep
                        else -> GrowthColors.BlueDeep
                    }
                    val wash = when {
                        focus -> GrowthColors.SunWash
                        speaking -> GrowthColors.PrimaryWash
                        else -> GrowthColors.BlueWash
                    }
                    Box(
                        Modifier
                            .clip(GrowthShapes.Pill)
                            .background(wash)
                            .border(1.dp, tint.copy(alpha = 0.35f), GrowthShapes.Pill)
                            .padding(horizontal = 14.dp, vertical = 8.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(letter, style = MaterialTheme.typography.titleLarge, color = tint)
                    }
                }
            }
        }
        Text(
            if (speaking) "老师正在读：眼睛跟着字母和音标，听完再跟读一遍。"
            else "先看字母，再听音标，最后自己读一遍。",
            style = MaterialTheme.typography.bodySmall,
            color = GrowthColors.InkSoft,
        )
        if (focusIndexes.isNotEmpty()) {
            Text(
                "黄色字母是这次要多练的部分。",
                style = MaterialTheme.typography.bodySmall,
                color = GrowthColors.SunDeep,
            )
        }
    }
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
private fun WeeklyReportCard(
    report: JSONObject?,
    error: String,
    refreshing: Boolean,
    refreshStatus: String,
    onRefresh: () -> Unit,
) {
    GrowthCard(modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            GrowthSectionTitle("成长周报", "📊")
            Spacer(Modifier.weight(1f))
            GrowthPill("家长可见", GrowthColors.ForestDeep, GrowthColors.ForestWash, emoji = "👨‍👩‍👧")
        }
        if (error.isNotBlank()) {
            Text(error, style = MaterialTheme.typography.bodySmall, color = GrowthColors.Danger)
        }
        if (report == null) {
            Text(
                "正在加载本周学习记录…",
                style = MaterialTheme.typography.bodyMedium,
                color = GrowthColors.InkSoft,
            )
        } else {
            Text(
                "${report.optString("weekStart")} — ${report.optString("weekEnd")} · Asia/Shanghai",
                style = MaterialTheme.typography.bodySmall,
                color = GrowthColors.InkSoft,
            )
            Text(
                "这是本周学习记录，不是能力结论。",
                style = MaterialTheme.typography.bodySmall,
                color = GrowthColors.InkSoft,
            )

            val summary = report.optJSONObject("summary")
            val reviews = report.optJSONObject("reviews")
            val metrics = listOf(
                Tile("课堂", "${summary?.optInt("sessions", 0) ?: 0} 次", "📖", GrowthColors.PrimaryDeep, GrowthColors.PrimaryWash),
                Tile("学习时长", "${summary?.optInt("learningMinutes", 0) ?: 0} 分钟", "⏱️", GrowthColors.SunDeep, GrowthColors.SunWash),
                Tile("独立完成", "${summary?.optInt("independentSuccesses", 0) ?: 0} 次", "🌟", GrowthColors.MintDeep, GrowthColors.MintWash),
                Tile("待复习", "${reviews?.optInt("dueCount", 0) ?: 0} 个", "🔁", GrowthColors.ForestDeep, GrowthColors.ForestWash),
            )
            metrics.chunked(2).forEach { row ->
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    row.forEach { tile ->
                        GrowthStatTile(
                            tile.value,
                            tile.label,
                            tile.emoji,
                            tile.tint,
                            tile.wash,
                            Modifier.weight(1f),
                        )
                    }
                    if (row.size == 1) Spacer(Modifier.weight(1f))
                }
            }

            if (!report.optBoolean("hasData", false)) {
                Text(
                    "本周还没有足够的课堂记录。完成一次课堂后，这里会自动汇总。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = GrowthColors.InkSoft,
                )
            }

            val highlights = report.jsonObjects("highlights")
            if (highlights.isNotEmpty()) {
                GrowthSectionTitle("本周亮点", "✨")
                highlights.forEach { item ->
                    Text(
                        "${item.optString("skillName")} · ${item.optString("abilityLabel")} · 独立完成 ${item.optInt("independentSuccesses", 0)} 次",
                        style = MaterialTheme.typography.bodyMedium,
                        color = GrowthColors.Ink,
                    )
                }
            }

            val needsPractice = report.jsonObjects("needsPractice")
            if (needsPractice.isNotEmpty()) {
                GrowthSectionTitle("本周需要再练", "🌱")
                needsPractice.forEach { item ->
                    Text(
                        "${item.optString("skillName")} · ${item.optString("abilityLabel")} · ${item.optInt("unsuccessfulAttempts", 0)} 次需要帮助",
                        style = MaterialTheme.typography.bodyMedium,
                        color = GrowthColors.Ink,
                    )
                    val focus = item.jsonObjects("errorUnits").joinToString("、") { unit ->
                        "${errorUnitLabel(unit.optString("unit"))} ${unit.optInt("count", 0)} 次"
                    }
                    if (focus.isNotBlank()) {
                        Text("先复习：$focus", style = MaterialTheme.typography.bodySmall, color = GrowthColors.InkSoft)
                    }
                    if (item.optBoolean("priorIndependentSuccess", false)) {
                        Text(
                            "之前独立完成过，这次再熟悉一下就好。",
                            style = MaterialTheme.typography.bodySmall,
                            color = GrowthColors.ForestDeep,
                        )
                    }
                }
            }

            val dueCount = reviews?.optInt("dueCount", 0) ?: 0
            if (dueCount > 0) {
                GrowthSectionTitle("近期需要巩固", "🔁")
                val overdue = reviews?.optInt("overdueCount", 0) ?: 0
                Text(
                    if (overdue > 0) "有 $dueCount 个复习项到期，其中 $overdue 个已等待一段时间。" else "有 $dueCount 个复习项到期。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = GrowthColors.Ink,
                )
                reviews?.jsonObjects("items").orEmpty().forEach { item ->
                    Text(
                        "${item.optString("skillName")} · ${item.optString("dueAt").take(10)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = GrowthColors.InkSoft,
                    )
                }
            }

            val suggestions = report.optJSONObject("nextWeek").stringItems("suggestions")
            if (suggestions.isNotEmpty()) {
                GrowthSectionTitle("下周建议", "🧭")
                suggestions.forEach { item ->
                    Text("• $item", style = MaterialTheme.typography.bodyMedium, color = GrowthColors.Ink)
                }
            }

            Text(
                report.optString("calibrationNotice"),
                style = MaterialTheme.typography.bodySmall,
                color = GrowthColors.InkSoft,
            )
        }
        if (refreshStatus.isNotBlank()) GrowthStatusPill(refreshStatus)
        GrowthSecondaryButton(
            when {
                refreshing -> "正在刷新周报…"
                report == null -> "加载周报"
                else -> "刷新周报"
            },
            onRefresh,
            emoji = "🔄",
            enabled = !refreshing,
        )
    }
}

@Composable
private fun ParentAreaCard(
    unlocked: Boolean,
    onUnlockRequest: () -> Unit,
    onLock: () -> Unit,
    onPrivacy: () -> Unit,
    onPayment: () -> Unit,
    onDeleteRequest: () -> Unit,
) {
    GrowthCard(modifier = Modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            GrowthSectionTitle("家长区", if (unlocked) "🔓" else "🔒")
            Spacer(Modifier.weight(1f))
            GrowthPill(
                if (unlocked) "家长已验证" else "孩子端",
                if (unlocked) GrowthColors.MintDeep else GrowthColors.SunDeep,
                if (unlocked) GrowthColors.MintWash else GrowthColors.SunWash,
                emoji = if (unlocked) "✅" else "🧒",
            )
        }
        if (!unlocked) {
            Text(
                "注销账号、隐私协议和会员支付仅家长可操作；孩子端不会显示这些入口。",
                style = MaterialTheme.typography.bodyMedium,
                color = GrowthColors.InkSoft,
            )
            GrowthSecondaryButton("家长验证", onUnlockRequest, emoji = "🔐")
        } else {
            Text(
                "已解锁本次运行期的家长操作；重新打开应用后会自动锁定，也可随时手动锁定。",
                style = MaterialTheme.typography.bodySmall,
                color = GrowthColors.InkSoft,
            )
            GrowthLinkRow("隐私协议", "🛡️", onPrivacy)
            GrowthLinkRow("家庭会员与支付（即将开放）", "💳", onPayment)
            GrowthLinkRow("注销账号", "⚠️", onDeleteRequest, danger = true)
            GrowthSecondaryButton("锁定家长区", onLock, emoji = "🔒")
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
    weekly: JSONObject?, weeklyError: String, weeklyRefreshing: Boolean, weeklyStatus: String,
    onRefreshWeekly: () -> Unit,
    parentUnlocked: Boolean, onParentUnlocked: () -> Unit, onLockParent: () -> Unit, onPayment: () -> Unit,
) {
    val user = data?.optJSONObject("user")
    var textbookMenu by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var showParentGate by remember { mutableStateOf(false) }
    var gateA by remember { mutableStateOf(0) }
    var gateB by remember { mutableStateOf(0) }
    var gateAnswer by remember { mutableStateOf("") }
    var gateError by remember { mutableStateOf("") }

    fun openParentGate() {
        gateA = (12..99).random()
        gateB = (2..9).random()
        gateAnswer = ""
        gateError = ""
        showParentGate = true
    }

    fun submitParentGate() {
        if (gateAnswer.toIntOrNull() == gateA * gateB) {
            onParentUnlocked()
            showParentGate = false
            gateAnswer = ""
            gateError = ""
        } else {
            gateA = (12..99).random()
            gateB = (2..9).random()
            gateAnswer = ""
            gateError = "答案不对，请家长再试一道。"
        }
    }
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

    WeeklyReportCard(weekly, weeklyError, weeklyRefreshing, weeklyStatus, onRefreshWeekly)

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

    ParentAreaCard(
        unlocked = parentUnlocked,
        onUnlockRequest = ::openParentGate,
        onLock = { confirmDelete = false; onLockParent() },
        onPrivacy = onPrivacy,
        onPayment = onPayment,
        onDeleteRequest = { confirmDelete = true },
    )

    GrowthCard(modifier = Modifier.fillMaxWidth()) {
        GrowthSectionTitle("偏好与协议", "⚙️")
        GrowthSecondaryButton(
            if (childTheme) "切换成人主题" else "切换儿童主题",
            { onTheme(!childTheme) },
            emoji = if (childTheme) "🌿" else "🌈",
        )
        GrowthLinkRow("用户协议", "📄", onTerms)
    }

    GrowthCard(modifier = Modifier.fillMaxWidth()) {
        GrowthSectionTitle("账户", "👋")
        GrowthLinkRow("退出登录", "🚪", onLogout)
    }

    if (parentUnlocked && confirmDelete) AlertDialog(
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

    if (showParentGate) AlertDialog(
        onDismissRequest = {
            showParentGate = false
            gateAnswer = ""
            gateError = ""
        },
        containerColor = GrowthColors.Surface,
        shape = GrowthShapes.Card,
        titleContentColor = GrowthColors.Ink,
        textContentColor = GrowthColors.InkSoft,
        title = { Text("家长验证", style = MaterialTheme.typography.headlineSmall) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    "请家长完成下面的乘法题。验证后可管理账户、隐私与支付设置。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = GrowthColors.InkSoft,
                )
                Text(
                    "$gateA × $gateB = ?",
                    style = MaterialTheme.typography.headlineMedium,
                    color = GrowthColors.ForestDeep,
                )
                GrowthTextField(
                    gateAnswer,
                    { gateAnswer = it.filter(Char::isDigit).take(4) },
                    "答案",
                    placeholder = "输入乘积",
                    leadingEmoji = "✏️",
                )
                if (gateError.isNotBlank()) {
                    Text(gateError, style = MaterialTheme.typography.bodySmall, color = GrowthColors.Danger)
                }
                Text(
                    "孩子端不会显示注销、隐私协议与支付入口。",
                    style = MaterialTheme.typography.bodySmall,
                    color = GrowthColors.InkSoft,
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { submitParentGate() },
                enabled = gateAnswer.isNotBlank(),
                modifier = Modifier.height(48.dp),
            ) {
                Text("解锁家长区", style = MaterialTheme.typography.titleMedium)
            }
        },
        dismissButton = {
            TextButton(
                onClick = {
                    showParentGate = false
                    gateAnswer = ""
                    gateError = ""
                },
                modifier = Modifier.height(48.dp),
            ) {
                Text("取消", style = MaterialTheme.typography.titleMedium)
            }
        },
    )
    if (status.isNotBlank()) GrowthStatusPill(status)
}

/* ------------------------------------------------------------- 网络层 */

internal fun http(base: String, path: String, method: String, body: JSONObject? = null, token: String? = null, headers: Map<String, String> = emptyMap()): JSONObject {
    val connection = URL("${base.trimEnd('/')}$path").openConnection() as HttpURLConnection
    connection.requestMethod = method
    connection.connectTimeout = 10_000
    connection.readTimeout = 20_000
    connection.setRequestProperty("Accept", "application/json")
    if (!token.isNullOrBlank()) connection.setRequestProperty("Authorization", "Bearer $token")
    headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
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

private fun httpBytes(base: String, path: String, bytes: ByteArray, contentType: String, token: String?, headers: Map<String, String>): JSONObject {
    val connection = URL("${base.trimEnd('/')}$path").openConnection() as HttpURLConnection
    connection.requestMethod = "POST"; connection.doOutput = true; connection.connectTimeout = 10_000; connection.readTimeout = 30_000
    connection.setRequestProperty("Accept", "application/json"); connection.setRequestProperty("Content-Type", contentType)
    if (!token.isNullOrBlank()) connection.setRequestProperty("Authorization", "Bearer $token")
    headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
    connection.outputStream.use { it.write(bytes) }
    return try {
        val code = connection.responseCode
        val text = (if (code in 200..299) connection.inputStream else connection.errorStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
        val result = JSONObject(text)
        if (code !in 200..299) error(result.optString("message").ifBlank { "请求失败（$code）" })
        result
    } finally { connection.disconnect() }
}
