package com.alg.languagegrowth

import org.json.JSONObject

/**
 * P4-03：角色扮演/复述任务。
 *
 * 取题时只下发情境和必用短语；参考答案由判分接口在提交后返回。首版使用长文本
 * 输入，不接录音/ASR，避免把“会说”误当成“会写”，也避免在没有评测额度时卡住课堂。
 */
internal data class ExpressionTask(
    val id: String,
    val kind: String,
    val title: String,
    val scenarioZh: String,
    val promptEn: String,
    val promptZh: String,
    val requiredPhrases: List<String>,
)

internal data class ExpressionGrade(
    val answer: String,
    val referenceAnswer: String,
    val matchedPhrases: List<String>,
    val missingPhrases: List<String>,
    val coverage: Double,
    val passed: Boolean,
    val feedbackZh: String,
)

internal fun parseExpressionTask(raw: JSONObject): ExpressionTask? {
    val task = raw.optJSONObject("task") ?: return null
    val id = task.optString("id", "").trim()
    val title = task.optString("title", "").trim()
    val promptZh = task.optString("promptZh", "").trim()
    if (id.isEmpty() || title.isEmpty() || promptZh.isEmpty()) return null
    val phrases = buildList {
        val array = task.optJSONArray("requiredPhrases")
        for (index in 0 until (array?.length() ?: 0)) {
            array?.optString(index, "")?.trim()?.takeIf { it.isNotEmpty() }?.let(::add)
        }
    }.distinct().take(4)
    if (phrases.size < 2) return null
    return ExpressionTask(
        id = id,
        kind = if (task.optString("kind", "").trim() == "retell") "retell" else "role_play",
        title = title,
        scenarioZh = task.optString("scenarioZh", "").trim(),
        promptEn = task.optString("promptEn", "").trim(),
        promptZh = promptZh,
        requiredPhrases = phrases,
    )
}

internal fun parseExpressionGrade(raw: JSONObject): ExpressionGrade {
    return ExpressionGrade(
        answer = raw.optString("answer", "").trim(),
        referenceAnswer = raw.optString("referenceAnswer", "").trim(),
        matchedPhrases = stringList(raw, "matchedPhrases"),
        missingPhrases = stringList(raw, "missingPhrases"),
        coverage = raw.optDouble("coverage", 0.0),
        passed = raw.optBoolean("passed", false),
        feedbackZh = raw.optString("feedbackZh", "").trim(),
    )
}

internal fun expressionGradeBody(answer: String): JSONObject =
    JSONObject().put("answer", answer.trim())

internal fun ExpressionTask.kindLabel(): String =
    if (kind == "retell") "复述任务" else "角色扮演"

private fun stringList(raw: JSONObject, key: String): List<String> {
    val array = raw.optJSONArray(key) ?: return emptyList()
    return (0 until array.length())
        .mapNotNull { index -> array.optString(index, "").trim().takeIf { it.isNotEmpty() } }
}
