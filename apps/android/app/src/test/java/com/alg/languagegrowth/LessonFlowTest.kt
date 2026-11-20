package com.alg.languagegrowth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 新课堂流程的过关门禁：>50 才能前进，词汇要累计 3 次。 */
class LessonFlowTest {

    @Test
    fun `分句低于等于50分停在原句`() {
        val state = LessonFlowState(stage = LessonStage.SENTENCE, sentenceIndex = 1)
        assertEquals(state, state.afterSentenceScore(50.0, sentenceCount = 5, wordCount = 4))
        assertEquals(state, state.afterSentenceScore(12.0, sentenceCount = 5, wordCount = 4))
    }

    @Test
    fun `分句超过50分进入下一句`() {
        val state = LessonFlowState(stage = LessonStage.SENTENCE, sentenceIndex = 1)
        val next = state.afterSentenceScore(51.0, sentenceCount = 5, wordCount = 4)
        assertEquals(2, next.sentenceIndex)
        assertEquals(LessonStage.SENTENCE, next.stage)
    }

    @Test
    fun `最后一句读完进入重点词`() {
        val state = LessonFlowState(stage = LessonStage.SENTENCE, sentenceIndex = 4)
        val next = state.afterSentenceScore(90.0, sentenceCount = 5, wordCount = 4)
        assertEquals(LessonStage.WORDS, next.stage)
        assertEquals(0, next.wordIndex)
        assertEquals(0, next.wordPasses)
    }

    @Test
    fun `没有重点词时直接进入语法`() {
        val state = LessonFlowState(stage = LessonStage.SENTENCE, sentenceIndex = 4)
        val next = state.afterSentenceScore(90.0, sentenceCount = 5, wordCount = 0)
        assertEquals(LessonStage.GRAMMAR, next.stage)
    }

    @Test
    fun `词汇同一词要累计三次才换词`() {
        var state = LessonFlowState(stage = LessonStage.WORDS, wordIndex = 0)
        state = state.afterWordScore(80.0, wordCount = 2)
        assertEquals(1, state.wordPasses)
        state = state.afterWordScore(80.0, wordCount = 2)
        assertEquals(2, state.wordPasses)
        state = state.afterWordScore(80.0, wordCount = 2)
        assertEquals(1, state.wordIndex)
        assertEquals(0, state.wordPasses)
        assertEquals(LessonStage.WORDS, state.stage)
    }

    @Test
    fun `词汇未过50分不计数`() {
        val state = LessonFlowState(stage = LessonStage.WORDS, wordIndex = 0, wordPasses = 2)
        val next = state.afterWordScore(49.0, wordCount = 2)
        assertEquals(2, next.wordPasses)
        assertEquals(0, next.wordIndex)
    }

    @Test
    fun `最后一个词通过三次后进入语法`() {
        val state = LessonFlowState(stage = LessonStage.WORDS, wordIndex = 1, wordPasses = 2)
        val next = state.afterWordScore(75.0, wordCount = 2)
        assertEquals(LessonStage.GRAMMAR, next.stage)
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
