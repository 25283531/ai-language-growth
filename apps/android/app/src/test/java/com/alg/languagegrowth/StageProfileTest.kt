package com.alg.languagegrowth

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * P3-03 七领域阶段画像的客户端解析回归。
 *
 * 约束来自任务书 §10.1 / §10.6：
 *  - 七个领域分别显示，不是总等级；
 *  - 阶段范围 0—6；
 *  - 缺失字段不得伪造阶段，旧 dashboard 没有 stageProfile 时返回 null。
 */
class StageProfileTest {

    private fun dashboardWith(stageProfile: String): JSONObject = JSONObject(
        """{"stageProfile":$stageProfile}""",
    )

    @Test
    fun `parses seven domains with independent stages and counts`() {
        val raw = dashboardWith(
            """
            {
              "learnerId":"learner-1",
              "stages":{"listening":3,"pronunciation":0,"vocabulary":3,"grammar":1,
                        "speaking":2,"communication":2,"schoolEnglish":1},
              "stageNodeCounts":{"listening":2,"pronunciation":0,"vocabulary":1,"grammar":1,
                                 "speaking":1,"communication":1,"schoolEnglish":1},
              "evidenceCounts":{"listening":8,"pronunciation":0,"vocabulary":5,"grammar":2,
                                "speaking":3,"communication":2,"schoolEnglish":1},
              "computedAt":"2026-11-24T00:00:00.000Z"
            }
            """.trimIndent(),
        )

        val profile = parseStageProfile(raw.optJSONObject("stageProfile"))!!
        assertEquals(7, profile.rows.size)
        assertEquals(
            listOf("听力", "发音", "词汇", "语法", "口语", "交流", "学校英语"),
            profile.rows.map { it.label },
        )
        assertEquals(listOf(3, 0, 3, 1, 2, 2, 1), profile.rows.map { it.stage })
        assertEquals(2, profile.rows.first().nodeCount)
        assertEquals(8, profile.rows.first().evidenceCount)
        assertEquals("阶段 3", stageProfileLabel(profile.rows.first().stage))
        assertEquals("尚未开始", stageProfileLabel(profile.rows[1].stage))
    }

    @Test
    fun `missing stageProfile returns null instead of inventing stages`() {
        assertNull(parseStageProfile(null))
        assertNull(parseStageProfile(JSONObject("""{"abilities":[]}""")))
    }

    @Test
    fun `missing or out-of-range stage is clamped without affecting other domains`() {
        val raw = dashboardWith(
            """{"stages":{"listening":9,"pronunciation":-2,"vocabulary":2}}""",
        )

        val profile = parseStageProfile(raw.optJSONObject("stageProfile"))!!
        assertEquals(6, profile.rows.first { it.key == "listening" }.stage)
        assertEquals(0, profile.rows.first { it.key == "pronunciation" }.stage)
        assertEquals(2, profile.rows.first { it.key == "vocabulary" }.stage)
        assertEquals(0, profile.rows.first { it.key == "grammar" }.stage)
        assertEquals(7, profile.rows.size)
    }
}
