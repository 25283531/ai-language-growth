package com.alg.languagegrowth

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.Locale

/** App 在线更新通道：清单和安装包都从 Language Growth 的 OpenList 目录读取。 */
object AppUpdateChannel {
    const val API_URL = "https://alist.250886.xyz:32123/api/fs/get"
    const val ROOT_PATH = "/Language Growth/app"
    const val MANIFEST_PATH = "$ROOT_PATH/latest.json"
    private const val ALLOWED_HOST = "alist.250886.xyz"
    private const val ALLOWED_PORT = 32123
    private const val MAX_MANIFEST_BYTES = 256 * 1024
    private const val MAX_APK_BYTES = 300L * 1024 * 1024

    data class UpdateInfo(
        val versionCode: Int,
        val versionName: String,
        val apkPath: String,
        val sha256: String,
        val sizeBytes: Long,
        val changelog: List<String>,
        val force: Boolean,
    )

    fun installedVersion(context: Context): Pair<Int, String> {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        @Suppress("DEPRECATION")
        val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode.toInt() else info.versionCode
        return code to (info.versionName ?: "0")
    }

    /** 失败时返回 null，更新检查绝不阻塞主界面。 */
    suspend fun check(context: Context): UpdateInfo? = withContext(Dispatchers.IO) {
        val (currentCode, _) = installedVersion(context)
        val raw = readRawFile(MANIFEST_PATH)
        val info = parseManifest(raw, context.packageName, currentCode)
        if (info.versionCode > currentCode) info else null
    }

    /** 解析并校验清单；纯函数，供单元测试覆盖。 */
    fun parseManifest(raw: String, expectedAppId: String, currentVersionCode: Int): UpdateInfo {
        val json = JSONObject(raw)
        require(json.optInt("schemaVersion", 0) == 1) { "更新清单版本不受支持" }
        require(json.optString("appId") == expectedAppId) { "更新清单不属于当前应用" }
        val versionCode = json.optInt("versionCode", 0)
        val versionName = json.optString("versionName").trim()
        require(versionCode > 0) { "更新清单缺少版本号" }
        require(versionName.isNotEmpty()) { "更新清单缺少版本名称" }
        val apkPath = json.optString("apkPath").trim()
        require(isSafeRelativeApkPath(apkPath)) { "更新包路径不合法" }
        val sha256 = json.optString("sha256").trim().lowercase(Locale.US)
        require(sha256.matches(Regex("[0-9a-f]{64}"))) { "更新包摘要不合法" }
        val sizeBytes = json.optLong("sizeBytes", 0)
        require(sizeBytes in 1..MAX_APK_BYTES) { "更新包大小不合法" }
        val changelog = json.optJSONArray("changelog")?.let(::readStringArray).orEmpty()
        require(changelog.isNotEmpty()) { "更新清单缺少更新内容" }
        val minSupported = json.optInt("minSupportedVersionCode", 0)
        val force = json.optBoolean("force", false) || currentVersionCode < minSupported
        return UpdateInfo(
            versionCode = versionCode,
            versionName = versionName,
            apkPath = apkPath,
            sha256 = sha256,
            sizeBytes = sizeBytes,
            changelog = changelog,
            force = force,
        )
    }

    suspend fun download(
        context: Context,
        info: UpdateInfo,
        onProgress: (Float) -> Unit,
    ): File = withContext(Dispatchers.IO) {
        val rawUrl = resolveRawUrl("$ROOT_PATH/${info.apkPath}")
        val directory = File(context.cacheDir, "updates").apply { mkdirs() }
        val part = File(directory, "app-${info.versionCode}.apk.part")
        val target = File(directory, "app-${info.versionCode}.apk")
        if (target.exists()) target.delete()
        if (part.exists()) part.delete()
        var total = 0L
        val digest = MessageDigest.getInstance("SHA-256")
        val connection = (URL(rawUrl).openConnection() as HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 60_000
            instanceFollowRedirects = true
            setRequestProperty("Accept", "application/octet-stream")
        }
        try {
            require(connection.responseCode == HttpURLConnection.HTTP_OK) {
                "更新包下载失败（HTTP ${connection.responseCode}）"
            }
            val expected = connection.contentLengthLong.takeIf { it > 0 } ?: info.sizeBytes
            connection.inputStream.use { input ->
                FileOutputStream(part).use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var lastPercent = -1
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        if (total + read > MAX_APK_BYTES) throw IllegalStateException("更新包过大")
                        output.write(buffer, 0, read)
                        digest.update(buffer, 0, read)
                        total += read
                        val percent = ((total * 100) / expected).toInt().coerceIn(0, 100)
                        if (percent != lastPercent) {
                            lastPercent = percent
                            onProgress(percent / 100f)
                        }
                    }
                }
            }
            require(total == info.sizeBytes) { "更新包大小不一致" }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            require(actual == info.sha256) { "更新包校验失败，请重试" }
            require(part.renameTo(target)) { "更新包保存失败" }
            target
        } catch (error: Throwable) {
            part.delete()
            throw error
        } finally {
            connection.disconnect()
        }
    }

    fun canInstall(context: Context): Boolean =
        Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()

    fun openInstallPermission(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    fun install(context: Context, file: File) {
        val uri = FileProvider.getUriForFile(
            context,
            "${context.packageName}.fileprovider",
            file,
        )
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    private fun readRawFile(path: String): String {
        val rawUrl = resolveRawUrl(path)
        val connection = (URL(rawUrl).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 20_000
            instanceFollowRedirects = true
            setRequestProperty("Accept", "application/json")
        }
        try {
            require(connection.responseCode == HttpURLConnection.HTTP_OK) {
                "更新清单读取失败（HTTP ${connection.responseCode}）"
            }
            val bytes = connection.inputStream.use { readLimited(it, MAX_MANIFEST_BYTES) }
            return bytes.toString(Charsets.UTF_8)
        } finally {
            connection.disconnect()
        }
    }

    /** OpenList 的公开直链需要签名；先通过匿名 fs/get 换取当前 raw_url。 */
    private fun resolveRawUrl(path: String): String {
        require(path.startsWith("$ROOT_PATH/")) { "更新文件路径越界" }
        val body = JSONObject()
            .put("path", path)
            .put("password", "")
            .toString()
        val connection = (URL(API_URL).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 15_000
            readTimeout = 20_000
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
        val response = try {
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = connection.responseCode
            val stream = if (code == HttpURLConnection.HTTP_OK) connection.inputStream else connection.errorStream
            val text = stream?.use { readLimited(it, MAX_MANIFEST_BYTES).toString(Charsets.UTF_8) }.orEmpty()
            require(code == HttpURLConnection.HTTP_OK) { "更新服务不可用（HTTP $code）" }
            JSONObject(text)
        } finally {
            connection.disconnect()
        }
        require(response.optInt("code", -1) == 200) {
            response.optString("message").ifBlank { "更新文件不存在" }
        }
        val data = response.optJSONObject("data") ?: error("更新服务返回格式错误")
        val rawUrl = data.optString("raw_url").trim()
        require(rawUrl.isNotEmpty()) { "更新文件没有下载地址" }
        validateRawUrl(rawUrl)
        return rawUrl
    }

    private fun validateRawUrl(rawUrl: String) {
        val uri = URI(rawUrl)
        require(uri.scheme == "https") { "更新文件必须使用 HTTPS" }
        require(uri.host == ALLOWED_HOST && uri.port == ALLOWED_PORT) { "更新文件域名不合法" }
        val path = uri.path.orEmpty()
        require(path.startsWith("/p/file/Language Growth/app/")) { "更新文件路径不合法" }
        require(!path.contains("..")) { "更新文件路径不合法" }
    }

    private fun isSafeRelativeApkPath(path: String): Boolean =
        path.endsWith(".apk", ignoreCase = true) &&
            !path.startsWith("/") &&
            !path.contains("..") &&
            !path.contains('\\') &&
            path.split('/').all { it.isNotBlank() }

    private fun readStringArray(array: JSONArray): List<String> =
        (0 until array.length()).mapNotNull { index ->
            array.optString(index).trim().takeIf { it.isNotEmpty() }
        }

    private fun readLimited(input: InputStream, maxBytes: Int): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            require(total <= maxBytes) { "更新服务返回内容过大" }
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }
}

/**
 * 更新弹窗覆盖在完整 App 之上。检查失败静默忽略；下载和安装只在用户确认后发生。
 */
@Composable
fun AppUpdateGate(activity: MainActivity, content: @Composable () -> Unit) {
    val scope = rememberCoroutineScope()
    var update by remember { mutableStateOf<AppUpdateChannel.UpdateInfo?>(null) }
    var downloading by remember { mutableStateOf(false) }
    var progress by remember { mutableStateOf(0f) }
    var error by remember { mutableStateOf<String?>(null) }
    val currentVersion = remember { AppUpdateChannel.installedVersion(activity) }

    LaunchedEffect(Unit) {
        update = runCatching { AppUpdateChannel.check(activity) }.getOrNull()
    }

    androidx.compose.foundation.layout.Box(modifier = Modifier.fillMaxSize()) {
        content()
    }

    val info = update ?: return
    AlertDialog(
        onDismissRequest = {
            if (!info.force && !downloading) update = null
        },
        title = { Text("发现新版本 ${info.versionName}") },
        text = {
            Column(modifier = Modifier.padding(top = 4.dp)) {
                Text("当前版本 ${currentVersion.second}")
                Spacer(modifier = Modifier.height(12.dp))
                Text("更新内容")
                info.changelog.forEach { line ->
                    Text("• $line", modifier = Modifier.padding(top = 4.dp))
                }
                if (downloading) {
                    Spacer(modifier = Modifier.height(12.dp))
                    Text("正在下载 ${(progress * 100).toInt()}%")
                }
                error?.let {
                    Spacer(modifier = Modifier.height(12.dp))
                    Text(it)
                }
            }
        },
        confirmButton = {
            TextButton(
                enabled = !downloading,
                onClick = {
                    if (downloading) return@TextButton
                    if (!AppUpdateChannel.canInstall(activity)) {
                        AppUpdateChannel.openInstallPermission(activity)
                        error = "请允许安装未知应用，返回后再次点击“立即更新”。"
                        return@TextButton
                    }
                    downloading = true
                    progress = 0f
                    error = null
                    scope.launch {
                        runCatching {
                            AppUpdateChannel.download(activity, info) { value ->
                                activity.runOnUiThread { progress = value }
                            }
                        }.onSuccess { file ->
                            downloading = false
                            runCatching { AppUpdateChannel.install(activity, file) }
                                .onSuccess { update = null }
                                .onFailure { error = "无法打开安装器，请稍后重试。" }
                        }.onFailure {
                            downloading = false
                            error = it.message ?: "更新失败，请稍后重试。"
                        }
                    }
                },
            ) {
                Text(if (downloading) "下载中" else "立即更新")
            }
        },
        dismissButton = {
            if (!info.force) {
                TextButton(enabled = !downloading, onClick = { update = null }) {
                    Text("稍后")
                }
            }
        },
    )
}
