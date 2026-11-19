package com.alg.languagegrowth

import org.json.JSONObject

/**
 * 开课请求体。
 *
 * 服务端在 `dashboard.textbook.topicId` 给出「所选教材当前单元」对应的课程主题；
 * 开课带上它，课文与重点词才会按该单元装配（P2-06/P2-07 的入口）。
 * topicId 缺失时保持旧行为：服务端按学习者档案与能力自选主题。
 */
internal fun lessonStartBody(learnerId: String, topicId: String?): JSONObject =
    JSONObject().put("learnerId", learnerId).apply {
        val topic = topicId?.trim().orEmpty()
        if (topic.isNotEmpty() && topic != "null") put("topicId", topic)
    }

/**
 * 从 dashboard 的 textbook 段取当前单元主题。
 * 旧服务端没有该字段、或字段为 null 字面量时返回 null，客户端按旧流程开课。
 */
internal fun textbookTopicId(dashboard: JSONObject?): String? =
    dashboard
        ?.optJSONObject("textbook")
        ?.optString("topicId")
        ?.trim()
        ?.takeIf { it.isNotEmpty() && it != "null" }
