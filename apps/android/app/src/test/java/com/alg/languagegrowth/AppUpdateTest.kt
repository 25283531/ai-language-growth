package com.alg.languagegrowth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdateTest {
    private val manifest = """
        {
          "schemaVersion": 1,
          "appId": "com.alg.languagegrowth",
          "channel": "stable",
          "versionCode": 4,
          "versionName": "0.0.4",
          "minSupportedVersionCode": 3,
          "publishedAt": "2026-11-28T06:00:00Z",
          "apkPath": "stable/ai-language-growth-0.0.4-4.apk",
          "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "sizeBytes": 12345678,
          "changelog": ["新增在线更新检查", "修复音频播放问题"],
          "force": false
        }
    """.trimIndent()

    @Test
    fun parsesNewVersionAndChangelog() {
        val info = AppUpdateChannel.parseManifest(manifest, "com.alg.languagegrowth", 3)
        assertEquals(4, info.versionCode)
        assertEquals("0.0.4", info.versionName)
        assertEquals("stable/ai-language-growth-0.0.4-4.apk", info.apkPath)
        assertEquals(2, info.changelog.size)
        assertFalse(info.force)
    }

    @Test
    fun forcesUpdateBelowMinimumSupportedVersion() {
        val info = AppUpdateChannel.parseManifest(manifest, "com.alg.languagegrowth", 2)
        assertTrue(info.force)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsWrongAppId() {
        AppUpdateChannel.parseManifest(manifest, "com.example.other", 3)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsPathTraversal() {
        AppUpdateChannel.parseManifest(
            manifest.replace(
                "stable/ai-language-growth-0.0.4-4.apk",
                "../ai-language-growth-0.0.4-4.apk",
            ),
            "com.alg.languagegrowth",
            3,
        )
    }
}
