package com.alg.languagegrowth

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P2-06 重点词拆读的纯逻辑回归。
 *
 * 约束来自任务书 §7.2：
 *  - 片段顺序固定为 整词 → 音节 → 音素 → 合成 → 自然语速；
 *  - 评估指出错误音节/音素时只练出错部分，不要求整词盲目重读；
 *  - 最多陪练 5 轮，不催促。
 */
class PassagePracticeTest {

    private fun clip(
        key: String,
        kind: String,
        position: Int,
        text: String,
        partIndex: Int = 0,
        ref: String? = "/api/v1/media/audio/aaaaaaaaaaaaaaaaaaaaaaaa.mp3",
    ): String {
        val refJson = if (ref == null) "null" else JSONObject.quote(ref)
        return """
            {"key":"$key","kind":"$kind","partIndex":$partIndex,"position":$position,
             "speedTier":"slow","speed":0.65,"text":"$text","audioRef":$refJson,
             "durationMs":600,"status":"ready"}
        """.trimIndent()
    }

    private fun focusWordJson(): JSONObject {
        val clips = listOf(
            clip("family:w", "word", 0, "family"),
            clip("family:s1", "syllable", 1, "fam", 0),
            clip("family:s2", "syllable", 2, "i", 1),
            clip("family:s3", "syllable", 3, "ly", 2),
            clip("family:p1", "phoneme", 4, "/f/", 0),
            clip("family:b", "blend", 5, "family"),
            clip("family:n", "natural", 6, "family"),
        ).joinToString(",")
        return JSONObject(
            """
            {"word":"family","phonetic":"/ˈfæməli/","meaningZh":"家庭",
             "syllables":["fam","i","ly"],"difficultPhonemes":["/æ/"],
             "reason":"课文复现","clips":[$clips]}
            """.trimIndent(),
        )
    }

    @Test
    fun `parses focus words with ordered clips`() {
        val passage = JSONObject(
            """
            {"unitId":"u1","topicId":"t1","contentVersion":"v1","title":"My Family",
             "audioReady":true,
             "paragraphs":[{"sentences":[{"id":"u1-s01","en":"This is my family.","zh":"这是我的家庭。"}]}],
             "focusWords":[${focusWordJson()}]}
            """.trimIndent(),
        )

        val parsed = parseLessonPassage(passage)!!
        assertEquals(1, parsed.focusWords.size)
        val word = parsed.focusWords.first()
        assertEquals("family", word.word)
        assertEquals(listOf("fam", "i", "ly"), word.syllables)
        assertEquals(7, word.clips.size)
        assertTrue(word.playableClips.map { it.position } == listOf(0, 1, 2, 3, 4, 5, 6))
    }

    @Test
    fun `clips without audio ref stay visible but not playable`() {
        val raw = JSONObject(
            """{"word":"cat","clips":[${clip("cat:w", "word", 0, "cat", ref = null)}]}""",
        )
        val word = parseFocusWord(raw)!!
        assertEquals(1, word.clips.size)
        assertNull(word.clips.first().audioRef)
        assertTrue(word.playableClips.isEmpty())
    }

    @Test
    fun `full drill follows server order`() {
        val word = parseFocusWord(focusWordJson())!!
        val labels = focusDrillSteps(word).map { it.label }
        assertEquals(listOf("整词", "音节 1", "音节 2", "音节 3", "音素 /f/", "合起来", "自然语速"), labels)
    }

    @Test
    fun `error units narrow practice to the wrong syllable and keep blend plus natural`() {
        val word = parseFocusWord(focusWordJson())!!
        val steps = focusDrillSteps(word, listOf("fam"))
        assertEquals(listOf("音节 1", "合起来", "自然语速"), steps.map { it.label })
    }

    @Test
    fun `unmatched error unit falls back to word and natural speed`() {
        val word = parseFocusWord(focusWordJson())!!
        val steps = focusDrillSteps(word, listOf("zzz"))
        assertEquals(listOf("整词", "自然语速"), steps.map { it.label })
    }

    @Test
    fun `drill stops at five rounds and never scolds`() {
        var round = 0
        repeat(8) { round = nextDrillRound(round, passedNow = false) }
        assertEquals(FOCUS_DRILL_MAX_ROUNDS, round)
        assertTrue(drillStatusText(round, false, 40.0).contains("今天先练到这里"))
        assertTrue(!drillStatusText(round, false, 40.0).contains("不对"))
    }

    @Test
    fun `passing round keeps round count unchanged`() {
        assertEquals(2, nextDrillRound(2, passedNow = true))
        assertTrue(drillStatusText(0, true, 92.0).contains("读得很清楚"))
    }

    @Test
    fun `passage without focus words behaves as before`() {
        val passage = JSONObject(
            """
            {"unitId":"u1","topicId":"t1","contentVersion":"v1","title":"Old",
             "paragraphs":[{"sentences":[{"id":"u1-s01","en":"Hello.","zh":"你好。"}]}]}
            """.trimIndent(),
        )
        val parsed = parseLessonPassage(passage)!!
        assertTrue(parsed.focusWords.isEmpty())
        assertEquals(1, parsed.sentences.size)
    }
}
