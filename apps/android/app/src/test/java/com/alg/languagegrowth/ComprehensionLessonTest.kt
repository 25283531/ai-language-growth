package com.alg.languagegrowth

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ComprehensionLessonTest {

    @Test
    fun `判断题缺少选项时补成 true false`() {
        val items = parseComprehensionItems(
            JSONObject(
                """
                {"items":[
                  {"id":"c1","kind":"true_false","prompt":"The passage says: It is sunny.","options":[]}
                ]}
                """.trimIndent(),
            ),
        )
        assertEquals(1, items.size)
        assertEquals(listOf("true", "false"), items[0].options)
        assertEquals("✔ True（正确）", items[0].optionLabel("true"))
    }

    @Test
    fun `单选用服务端选项并跳过无效题`() {
        val items = parseComprehensionItems(
            JSONObject(
                """
                {"items":[
                  {"id":"c1","kind":"single_choice","prompt":"Which sentence is in the passage?","options":["A","B"]},
                  {"id":"c2","kind":"single_choice","prompt":"Only one option","options":["A"]},
                  {"id":"","kind":"true_false","prompt":"Missing id","options":["true","false"]}
                ]}
                """.trimIndent(),
            ),
        )
        assertEquals(listOf("c1"), items.map { it.id })
        assertEquals(listOf("A", "B"), items[0].options)
    }

    @Test
    fun `判分结果带答案与解析`() {
        val grade = parseComprehensionGrade(
            JSONObject(
                """
                {"correct":1,"total":2,"accuracy":0.5,"details":[
                  {"itemId":"c1","prompt":"Q1","answer":"true","correctAnswer":"true","correct":true,"explanationZh":"一致。"},
                  {"itemId":"c2","prompt":"Q2","answer":"A","correctAnswer":"B","correct":false,"explanationZh":"应选 B。"}
                ]}
                """.trimIndent(),
            ),
        )
        assertEquals(1, grade.correct)
        assertEquals(2, grade.total)
        assertEquals(0.5, grade.accuracy, 0.0)
        assertEquals(2, grade.details.size)
        assertTrue(grade.details[0].correct)
        assertEquals("应选 B。", grade.details[1].explanationZh)
    }

    @Test
    fun `提交体包含每道题的选择`() {
        val body = comprehensionGradeBody(mapOf("c1" to "true", "c2" to "B"))
        val answers = body.getJSONArray("answers")
        assertEquals(2, answers.length())
        val values = (0 until answers.length())
            .associate { answers.getJSONObject(it).getString("itemId") to answers.getJSONObject(it).getString("answer") }
        assertEquals(mapOf("c1" to "true", "c2" to "B"), values)
    }
}
