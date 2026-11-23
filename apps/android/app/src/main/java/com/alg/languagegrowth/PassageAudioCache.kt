package com.alg.languagegrowth

import java.io.File

/**
 * 课文音频的磁盘缓存。
 *
 * 服务端下发的 [audioRef] 已经绑定课程内容版本和媒体 ID，因此可以直接用
 * 路径末端的 `{24 位十六进制}.{mp3|wav|m4a}` 作为缓存文件名。缓存只保存
 * 已成功下载的完整文件，并按最近最少使用的时间清理到容量上限，供重启后
 * 或弱网时优先离线播放。
 */
internal class PassageAudioCache(
    private val root: File,
    private val maxBytes: Long = DEFAULT_MAX_BYTES,
) {
    private val lock = Any()
    private val audioName = Regex("""[a-fA-F0-9]{24}\.(mp3|wav|m4a)""")
    private val audioRefPattern = Regex("""/api/v1/media/audio/([a-fA-F0-9]{24}\.(mp3|wav|m4a))$""")

    fun find(audioRef: String): File? = synchronized(lock) {
        val target = targetFile(audioRef) ?: return null
        target.takeIf { it.isFile && it.length() > 0 }
    }

    /**
     * 将下载完成临时文件转存到缓存目录。缓存不可用时保留原临时文件，
     * 让当前播放仍能继续；任何情况下都不会返回半写入的目标文件。
     */
    fun store(audioRef: String, downloaded: File): File = synchronized(lock) {
        if (!downloaded.isFile || downloaded.length() <= 0) return downloaded
        val target = targetFile(audioRef) ?: return downloaded
        if (target == downloaded) return downloaded
        if (target.isFile && target.length() > 0) {
            downloaded.delete()
            return target
        }
        val parent = target.parentFile ?: return downloaded
        if (!parent.isDirectory && !parent.mkdirs()) return downloaded
        val part = File(parent, "${target.name}.part")
        return try {
            part.delete()
            downloaded.copyTo(part, overwrite = true)
            if (!part.renameTo(target)) {
                target.delete()
                if (!part.renameTo(target)) {
                    part.delete()
                    return downloaded
                }
            }
            downloaded.delete()
            trimToLimit()
            target
        } catch (_: Exception) {
            part.delete()
            downloaded
        }
    }

    fun clear() = synchronized(lock) {
        root.listFiles()
            ?.filter { it.isFile && audioName.matches(it.name) }
            ?.forEach { it.delete() }
    }

    private fun targetFile(audioRef: String): File? {
        val name = audioRefPattern.matchEntire(audioRef)?.groupValues?.get(1) ?: return null
        return File(root, name)
    }

    private fun trimToLimit() {
        val files = root.listFiles()
            ?.filter { it.isFile && audioName.matches(it.name) }
            ?.sortedBy { it.lastModified() }
            ?: return
        var total = files.sumOf { it.length() }
        if (total <= maxBytes) return
        for (file in files) {
            if (total <= maxBytes) break
            val length = file.length()
            if (file.delete()) total -= length
        }
    }

    private companion object {
        const val DEFAULT_MAX_BYTES = 64L * 1024 * 1024
    }
}
