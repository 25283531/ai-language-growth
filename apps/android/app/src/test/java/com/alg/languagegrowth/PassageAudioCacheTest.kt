package com.alg.languagegrowth

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.nio.file.Files

class PassageAudioCacheTest {
    private lateinit var root: File

    @Before
    fun setUp() {
        root = Files.createTempDirectory("passage-audio-cache").toFile()
    }

    @After
    fun tearDown() {
        root.deleteRecursively()
    }

    @Test
    fun rejectsRefsThatAreNotServerMediaPaths() {
        val cache = PassageAudioCache(root)
        val source = File(root, "unsafe.mp3").apply { writeBytes(byteArrayOf(1, 2, 3)) }

        assertNull(cache.find("https://evil.example/audio.mp3"))
        assertNull(cache.find("/api/v1/media/audio/not-a-hash.mp3"))
        assertEquals(source, cache.store("/api/v1/media/audio/not-a-hash.mp3", source))
        assertTrue(source.isFile)
    }

    @Test
    fun keepsDownloadedAudioAcrossControllerRestarts() {
        val ref = "/api/v1/media/audio/0123456789abcdef01234567.mp3"
        val source = File(root, "download.mp3").apply { writeBytes(byteArrayOf(1, 2, 3, 4)) }

        val first = PassageAudioCache(root)
        val stored = first.store(ref, source)
        assertTrue(stored.isFile)
        assertFalse(source.exists())

        // 新的缓存实例代表 App 重启：没有内存映射，仍能按 audioRef 找回文件。
        val afterRestart = PassageAudioCache(root)
        assertEquals(stored, afterRestart.find(ref))
    }

    @Test
    fun trimsOldestFilesWhenCacheExceedsLimit() {
        val cache = PassageAudioCache(root, maxBytes = 8)
        val firstRef = "/api/v1/media/audio/aaaaaaaaaaaaaaaaaaaaaaaa.mp3"
        val secondRef = "/api/v1/media/audio/bbbbbbbbbbbbbbbbbbbbbbbb.mp3"
        val thirdRef = "/api/v1/media/audio/cccccccccccccccccccccccc.mp3"

        val first = cache.store(firstRef, File(root, "first.mp3").apply { writeBytes(ByteArray(4)) })
        first.setLastModified(1_000)
        val second = cache.store(secondRef, File(root, "second.mp3").apply { writeBytes(ByteArray(4)) })
        second.setLastModified(2_000)
        val third = cache.store(thirdRef, File(root, "third.mp3").apply { writeBytes(ByteArray(4)) })

        assertNull(cache.find(firstRef))
        assertTrue(cache.find(secondRef)!!.isFile)
        assertTrue(third.isFile)
        assertTrue(cache.find(thirdRef)!!.isFile)
    }

    @Test
    fun clearOnlyRemovesCompletedAudioFiles() {
        val cache = PassageAudioCache(root)
        val ref = "/api/v1/media/audio/0123456789abcdef01234567.m4a"
        cache.store(ref, File(root, "download.m4a").apply { writeBytes(byteArrayOf(1)) })
        val unrelated = File(root, "keep.txt").apply { writeText("keep") }

        cache.clear()

        assertNull(cache.find(ref))
        assertTrue(unrelated.isFile)
    }
}
