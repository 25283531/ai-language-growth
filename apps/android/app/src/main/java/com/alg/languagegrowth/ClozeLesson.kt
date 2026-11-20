package com.alg.languagegrowth

import org.json.JSONObject

/**
 * P3：语法讲解 + 完形。
 *
 * 页面只渲染后端下发的内容与批改结果；「正确率 <80% 追加一批」的规则由服务端返回
 * `nextBatchIndex`，客户端不自行判断，避免两端口径漂移。
 */
internal data class ClozeGrammarPoint(
    val id: String,
    val titleZh: String,
    val explanationZh: String,
    val examples: List<ClozeExample>,
    val commonErrorZh: String,
)

internal data class ClozeExample(val en: String, val zh: String)

internal data class ClozeItem(
    val id: String,
    val sentence: String,
    val options: List<String>,
    val explanationZh: String,
    val grammarPointId: String,
)

internal data class ClozeBatch(
    val grammarPoints: List<ClozeGrammarPoint>,
    val batchIndex: Int,
    val items: List<ClozeItem>,
)

internal data class ClozeDetail(
    val itemId: String,
    val answer: String,
    val correctAnswer: String,
    val correct: Boolean,
    val explanationZh: String,
)

internal data class ClozeGrade(
    val correct: Int,
    val total: Int,
    val accuracy: Double,
    val passed: Boolean,
    val details: List<ClozeDetail>,
    val nextBatchIndex: Int?,
)

internal fun parseClozeBatch(raw: JSONObject): ClozeBatch {
    val grammarArray = raw.optJSONArray("grammarPoints")
    val grammar = (0 until (grammarArray?.length() ?: 0)).mapNotNull { index ->
        val item = grammarArray?.optJSONObject(index) ?: return@mapNotNull null
        val title = item.optString("titleZh", "").trim()
        if (title.isEmpty()) null else ClozeGrammarPoint(
            id = item.optString("id", "").trim(),
            titleZh = title,
            explanationZh = item.optString("explanationZh", "").trim(),
            examples = parseClozeExamples(item.optJSONArray("examples")),
            commonErrorZh = item.optString("commonErrorZh", "").trim(),
        )
    }
    val itemArray = raw.optJSONArray("items")
    val items = (0 until (itemArray?.length() ?: 0)).mapNotNull { index ->
        parseClozeItem(itemArray?.optJSONObject(index))
    }
    return ClozeBatch(
        grammarPoints = grammar,
        batchIndex = raw.optInt("batchIndex", 0),
        items = items,
    )
}

private fun parseClozeItem(raw: JSONObject?): ClozeItem? {
    if (raw == null) return null
    val id = raw.optString("id", "").trim()
    val sentence = raw.optString("sentence", "").trim()
    if (id.isEmpty() || sentence.isEmpty()) return null
    val optionsArray = raw.optJSONArray("options") ?: return null
    val options = (0 until optionsArray.length())
        .map { optionsArray.optString(it, "").trim() }
        .filter { it.isNotEmpty() }
    if (options.size < 2) return null
    return ClozeItem(
        id = id,
        sentence = sentence,
        options = options,
        explanationZh = raw.optString("explanationZh", "").trim(),
        grammarPointId = raw.optString("grammarPointId", "").trim(),
    )
}

private fun parseClozeExamples(array: org.json.JSONArray?): List<ClozeExample> {
    if (array == null) return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        val item = array.optJSONObject(index) ?: return@mapNotNull null
        val en = item.optString("en", "").trim()
        if (en.isEmpty()) null else ClozeExample(en, item.optString("zh", "").trim())
    }
}

internal fun parseClozeGrade(raw: JSONObject): ClozeGrade {
    val detailArray = raw.optJSONArray("details")
    val details = (0 until (detailArray?.length() ?: 0)).mapNotNull { index ->
        val item = detailArray?.optJSONObject(index) ?: return@mapNotNull null
        ClozeDetail(
            itemId = item.optString("itemId", "").trim(),
            answer = item.optString("answer", "").trim(),
            correctAnswer = item.optString("correctAnswer", "").trim(),
            correct = item.optBoolean("correct", false),
            explanationZh = item.optString("explanationZh", "").trim(),
        )
    }
    val next = if (raw.isNull("nextBatchIndex")) null else raw.optInt("nextBatchIndex")
    return ClozeGrade(
        correct = raw.optInt("correct", 0),
        total = raw.optInt("total", details.size),
        accuracy = raw.optDouble("accuracy", 0.0),
        passed = raw.optBoolean("passed", false),
        details = details,
        nextBatchIndex = next,
    )
}

internal fun clozeGradeBody(batchIndex: Int, selections: Map<String, String>): JSONObject {
    val answers = org.json.JSONArray()
    selections.forEach { (itemId, answer) ->
        answers.put(JSONObject().put("itemId", itemId).put("answer", answer))
    }
    return JSONObject().put("batchIndex", batchIndex).put("answers", answers)
}
