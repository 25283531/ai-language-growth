package com.alg.languagegrowth

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LessonStartTest {
    @Test
    fun sendsTopicIdWhenTextbookUnitIsSelected() {
        val body = lessonStartBody("learner-1", "topic-textbook-u07")
        assertEquals("learner-1", body.optString("learnerId"))
        assertEquals("topic-textbook-u07", body.optString("topicId"))
    }

    @Test
    fun keepsLegacyBodyWhenTopicIsMissing() {
        listOf(null, "", "   ", "null").forEach { topic ->
            val body = lessonStartBody("learner-1", topic)
            assertEquals("learner-1", body.optString("learnerId"))
            assertEquals(false, body.has("topicId"))
        }
    }

    @Test
    fun readsTopicFromDashboardTextbook() {
        val dashboard = JSONObject("""{"textbook":{"id":"m-1","currentUnit":"","topicId":"topic-textbook-u07"}}""")
        assertEquals("topic-textbook-u07", textbookTopicId(dashboard))
    }

    @Test
    fun toleratesDashboardWithoutTopic() {
        assertNull(textbookTopicId(null))
        assertNull(textbookTopicId(JSONObject("""{"textbook":null}""")))
        assertNull(textbookTopicId(JSONObject("""{"textbook":{"topicId":null}}""")))
        assertNull(textbookTopicId(JSONObject("""{"textbook":{"topicId":""}}""")))
        assertNull(textbookTopicId(JSONObject("""{"user":{"id":"u-1"}}""")))
    }
}
