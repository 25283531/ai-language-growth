package com.alg.languagegrowth

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExpressionTaskTest {

    @Test
    fun `解析角色扮演任务和必用短语`() {
        val task = parseExpressionTask(
            JSONObject(
                """
                {"task":{
                  "id":"e1","kind":"role_play","title":"在公园打招呼",
                  "scenarioZh":"你和同学在公园见面。","promptEn":"Say hello and ask about the weather.",
                  "promptZh":"和同学打招呼并询问天气。",
                  "requiredPhrases":["Good morning","How is the weather"]
                }}
                """.trimIndent(),
            ),
        )
        assertEquals("e1", task?.id)
        assertEquals("角色扮演", task?.kindLabel())
        assertEquals(2, task?.requiredPhrases?.size)
    }

    @Test
    fun `必用短语不足两条时不渲染任务`() {
        val task = parseExpressionTask(
            JSONObject(
                """
                {"task":{"id":"e1","kind":"retell","title":"复述","scenarioZh":"","promptEn":"","promptZh":"复述课文。","requiredPhrases":["Only one"]}}
                """.trimIndent(),
            ),
        )
        assertNull(task)
    }

    @Test
    fun `解析表达判分结果`() {
        val grade = parseExpressionGrade(
            JSONObject(
                """
                {"answer":"Good morning! How is the weather?","referenceAnswer":"Good morning. How is the weather?",
                 "matchedPhrases":["Good morning","How is the weather"],"missingPhrases":[],
                 "coverage":1.0,"passed":true,"feedbackZh":"表达完整。"}
                """.trimIndent(),
            ),
        )
        assertTrue(grade.passed)
        assertEquals(1.0, grade.coverage, 0.0)
        assertEquals(2, grade.matchedPhrases.size)
        assertTrue(grade.missingPhrases.isEmpty())
        assertEquals("表达完整。", grade.feedbackZh)
    }

    @Test
    fun `未通过时保留缺失短语`() {
        val grade = parseExpressionGrade(
            JSONObject(
                """
                {"answer":"Good morning.","referenceAnswer":"Good morning. How is the weather?",
                 "matchedPhrases":["Good morning"],"missingPhrases":["How is the weather"],
                 "coverage":0.5,"passed":false,"feedbackZh":"再试着用上缺失短语。"}
                """.trimIndent(),
            ),
        )
        assertFalse(grade.passed)
        assertEquals(listOf("How is the weather"), grade.missingPhrases)
    }

    @Test
    fun `提交体去掉首尾空格`() {
        assertEquals("Hello there.", expressionGradeBody("  Hello there.  ").getString("answer"))
    }
}
