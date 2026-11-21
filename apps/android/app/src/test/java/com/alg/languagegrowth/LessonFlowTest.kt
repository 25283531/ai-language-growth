package com.alg.languagegrowth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 新课堂流程：重点词 → 整篇 → 分句 → 语法 → 完形；>50 才能前进，词汇要累计 3 次。 */
class LessonFlowTest {

    @Test
    fun `课堂从重点词开始`() {
        assertEquals(LessonStage.WORDS, LessonFlowState().stage)
    }

    @Test
    fun `分句低于等于50分停在原句`() {
        val state = LessonFlowState(stage = LessonStage.SENTENCE, sentenceIndex = 1)
        assertEquals(state, state.afterSentenceScore(50.0, sentenceCount = 5))
        assertEquals(state, state.afterSentenceScore(12.0, sentenceCount = 5))
    }

    @Test
    fun `分句超过50分进入下一句`() {
        val state = LessonFlowState(stage = LessonStage.SENTENCE, sentenceIndex = 1)
        val next = state.afterSentenceScore(51.0, sentenceCount = 5)
        assertEquals(2, next.sentenceIndex)
        assertEquals(LessonStage.SENTENCE, next.stage)
    }

    @Test
    fun `最后一句读完进入语法`() {
        val state = LessonFlowState(stage = LessonStage.SENTENCE, sentenceIndex = 4)
        val next = state.afterSentenceScore(90.0, sentenceCount = 5)
        assertEquals(LessonStage.GRAMMAR, next.stage)
        assertEquals(0, next.wordPasses)
    }

    @Test
    fun `词汇同一词要累计三次才换词`() {
        var state = LessonFlowState(stage = LessonStage.WORDS, wordIndex = 0)
        state = state.withWordPass(80.0)
        assertEquals(1, state.wordPasses)
        state = state.withWordPass(80.0)
        assertEquals(2, state.wordPasses)
        assertEquals(0, state.wordIndex)
        state = state.withWordPass(80.0)
        assertEquals(3, state.wordPasses)
        // 不自动换词：孩子确认后再点「下一个词」。
        assertEquals(0, state.wordIndex)
        state = state.advanceWord(wordCount = 2)
        assertEquals(1, state.wordIndex)
        assertEquals(0, state.wordPasses)
        assertEquals(LessonStage.WORDS, state.stage)
    }

    @Test
    fun `词汇未过50分不计数`() {
        val state = LessonFlowState(stage = LessonStage.WORDS, wordIndex = 0, wordPasses = 2)
        val next = state.withWordPass(49.0)
        assertEquals(2, next.wordPasses)
        assertEquals(0, next.wordIndex)
    }

    @Test
    fun `没满三次不能换词`() {
        val state = LessonFlowState(stage = LessonStage.WORDS, wordIndex = 0, wordPasses = 2)
        assertEquals(state, state.advanceWord(wordCount = 3))
    }

    @Test
    fun `最后一个词通过三次后进入整篇课文`() {
        val state = LessonFlowState(stage = LessonStage.WORDS, wordIndex = 1, wordPasses = 3)
        val next = state.advanceWord(wordCount = 2)
        assertEquals(LessonStage.PASSAGE, next.stage)
        assertEquals(0, next.wordIndex)
        assertEquals(0, next.wordPasses)
    }

    @Test
    fun `跟读提示显示第几次和上次分数`() {
        assertEquals("第 1 次读 · 还没有上次分数", attemptLine(0, null))
        assertEquals("第 2 次读 · 上次 80 分", attemptLine(1, 80.4))
        assertEquals("第 4 次读 · 上次 62 分", attemptLine(3, 62.0))
    }

    @Test
    fun `旧服务端没有讲解稿时用本地模板`() {
        val word = FocusWord(
            word = "mother",
            phonetic = "/ˈmʌðə/",
            pos = "n.",
            meaningZh = "母亲",
            examples = listOf(FocusWordExample("I helped my mother.", "我帮了妈妈。")),
            forms = listOf("mothers"),
            syllables = emptyList(),
            difficultPhonemes = emptyList(),
            reason = "",
            clips = emptyList(),
        )
        val text = word.lessonExplanation()
        assertTrue(text.contains("名词"))
        assertTrue(text.contains("mothers"))
        assertTrue(text.contains("I helped my mother."))
    }
}
