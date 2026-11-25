package com.alg.languagegrowth

import org.json.JSONObject

/**
 * P4-02：教材单元理解题。
 *
 * 服务端只在取题时下发题干和选项，答案与解析随判分结果返回；客户端不缓存答案，
 * 也不自行判断对错，避免和另一端口径漂移。
 */
internal data class ComprehensionItem(
    val id: String,
    val kind: String,
    val prompt: String,
    val options: List<String>,
)

internal data class ComprehensionDetail(
    val itemId: String,
    val kind: String,
    val prompt: String,
    val answer: String,
    val correctAnswer: String,
    val correct: Boolean,
    val explanationZh: String,
)

internal data class ComprehensionGrade(
    val correct: Int,
    val total: Int,
    val accuracy: Double,
    val details: List<ComprehensionDetail>,
)

internal fun parseComprehensionItems(raw: JSONObject): List<ComprehensionItem> {
    val array = raw.optJSONArray("items") ?: return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        parseComprehensionItem(array.optJSONObject(index))
    }.distinctBy { it.id }
}

private fun parseComprehensionItem(raw: JSONObject?): ComprehensionItem? {
    if (raw == null) return null
    val id = raw.optString("id", "").trim()
    val prompt = raw.optString("prompt", "").trim()
    if (id.isEmpty() || prompt.isEmpty()) return null
    val kind = when (raw.optString("kind", "").trim()) {
        "true_false" -> "true_false"
        "single_choice" -> "single_choice"
        else -> return null
    }
    val options = buildList {
        val array = raw.optJSONArray("options")
        for (index in 0 until (array?.length() ?: 0)) {
            array?.optString(index, "")?.trim()?.takeIf { it.isNotEmpty() }?.let(::add)
        }
    }.distinct()
    val normalizedOptions = if (kind == "true_false" && options.size < 2) {
        listOf("true", "false")
    } else {
        options
    }
    if (normalizedOptions.size < 2) return null
    return ComprehensionItem(
        id = id,
        kind = kind,
        prompt = prompt,
        options = normalizedOptions,
    )
}

internal fun parseComprehensionGrade(raw: JSONObject): ComprehensionGrade {
    val array = raw.optJSONArray("details")
    val details = (0 until (array?.length() ?: 0)).mapNotNull { index ->
        val item = array?.optJSONObject(index) ?: return@mapNotNull null
        val itemId = item.optString("itemId", "").trim()
        if (itemId.isEmpty()) return@mapNotNull null
        ComprehensionDetail(
            itemId = itemId,
            kind = item.optString("kind", "").trim(),
            prompt = item.optString("prompt", "").trim(),
            answer = item.optString("answer", "").trim(),
            correctAnswer = item.optString("correctAnswer", "").trim(),
            correct = item.optBoolean("correct", false),
            explanationZh = item.optString("explanationZh", "").trim(),
        )
    }
    return ComprehensionGrade(
        correct = raw.optInt("correct", details.count { it.correct }),
        total = raw.optInt("total", details.size),
        accuracy = raw.optDouble("accuracy", 0.0),
        details = details,
    )
}

internal fun comprehensionGradeBody(selections: Map<String, String>): JSONObject {
    val answers = org.json.JSONArray()
    selections.forEach { (itemId, answer) ->
        answers.put(JSONObject().put("itemId", itemId).put("answer", answer))
    }
    return JSONObject().put("answers", answers)
}

/** 判断题统一显示成孩子能读懂的中文标签，提交值仍用服务端的 true/false。 */
internal fun ComprehensionItem.optionLabel(option: String): String = when {
    kind != "true_false" -> option
    option.equals("true", ignoreCase = true) -> "✔ True（正确）"
    option.equals("false", ignoreCase = true) -> "✘ False（错误）"
    else -> option
}
