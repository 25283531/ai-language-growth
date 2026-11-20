package com.alg.languagegrowth

import org.json.JSONObject

/**
 * 开课响应中的课文教学包。
 *
 * 服务端只在当前主题属于已发布教材单元时下发 passage；旧客户端忽略它即可。
 * 这里的解析保持容错：缺少音频引用时仍显示文字，只禁用点读按钮。
 */
internal data class LessonPassage(
    val unitId: String,
    val topicId: String,
    val contentVersion: String,
    val audioReady: Boolean,
    val title: String,
    val paragraphs: List<PassageParagraph>,
    /** 重点词拆读包；旧服务端不下发时为空，课文正文不受影响。 */
    val focusWords: List<FocusWord> = emptyList(),
    /** 语法讲解；旧服务端不下发时为空，可跳过语法环节。 */
    val grammar: List<GrammarPoint> = emptyList(),
) {
    val sentences: List<PassageSentence> = paragraphs.flatMap { it.sentences }
}

/** 本单元语法点：用课文例句讲清形式与用法。 */
internal data class GrammarPoint(
    val id: String,
    val title: String,
    val pattern: String,
    val explanation: String,
    val commonError: String = "",
    val examples: List<FocusWordExample> = emptyList(),
)

internal data class PassageParagraph(
    val sentences: List<PassageSentence>,
)

internal data class PassageSentence(
    val id: String,
    val english: String,
    val chinese: String,
    /** P1 整句音标；服务端查不全时为空，界面不展示。 */
    val phonetic: String = "",
    val audio: PassageSentenceAudio,
)

internal data class PassageSentenceAudio(
    val normalRef: String?,
    val slowRef: String?,
    val normalSpeed: Double,
    val slowSpeed: Double,
)

/** 一段可连续播放的课文音频；只保留真正有音频引用的句子。 */
internal data class PassageAudioItem(
    val sentenceId: String,
    val audioRef: String,
)

/** 按正常 / 慢速档位取出可连播的句子，缺音频的句子自动跳过。 */
internal fun LessonPassage.playbackItems(slow: Boolean): List<PassageAudioItem> =
    sentences.mapNotNull { sentence ->
        val ref = if (slow) sentence.audio.slowRef else sentence.audio.normalRef
        if (ref == null) null else PassageAudioItem(sentence.id, ref)
    }

internal fun parseLessonPassage(raw: JSONObject?): LessonPassage? {
    if (raw == null) return null
    val paragraphArray = raw.optJSONArray("paragraphs") ?: return null
    val paragraphs = (0 until paragraphArray.length()).mapNotNull { paragraphIndex ->
        val paragraphJson = paragraphArray.optJSONObject(paragraphIndex) ?: return@mapNotNull null
        val sentenceArray = paragraphJson.optJSONArray("sentences") ?: return@mapNotNull null
        val sentences = (0 until sentenceArray.length()).mapNotNull { sentenceIndex ->
            parsePassageSentence(sentenceArray.optJSONObject(sentenceIndex))
        }
        if (sentences.isEmpty()) null else PassageParagraph(sentences)
    }
    if (paragraphs.isEmpty()) return null
    return LessonPassage(
        unitId = raw.cleanString("unitId"),
        topicId = raw.cleanString("topicId"),
        contentVersion = raw.cleanString("contentVersion"),
        audioReady = raw.optBoolean("audioReady", false),
        title = raw.cleanString("title").ifBlank { "课文" },
        paragraphs = paragraphs,
        focusWords = parseFocusWords(raw),
        grammar = parseGrammarPoints(raw),
    )
}

private fun parsePassageSentence(raw: JSONObject?): PassageSentence? {
    if (raw == null) return null
    val id = raw.cleanString("id")
    val english = raw.cleanString("en")
    if (id.isBlank() || english.isBlank()) return null
    val audioJson = raw.optJSONObject("audio")
    return PassageSentence(
        id = id,
        english = english,
        chinese = raw.cleanString("zh"),
        phonetic = raw.cleanString("phonetic"),
        audio = PassageSentenceAudio(
            normalRef = audioJson.curriculumAudioRef("normalRef"),
            slowRef = audioJson.curriculumAudioRef("slowRef"),
            normalSpeed = audioJson.positiveSpeed("normalSpeed", 1.0),
            slowSpeed = audioJson.positiveSpeed("slowSpeed", 0.65),
        ),
    )
}

/** 解析语法讲解块；缺字段时返回空列表，课程直接跳过语法页。 */
internal fun parseGrammarPoints(raw: JSONObject?): List<GrammarPoint> {
    val array = raw?.optJSONArray("grammar") ?: return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        val item = array.optJSONObject(index) ?: return@mapNotNull null
        val title = item.cleanString("title")
        val explanation = item.cleanString("explanation")
        if (title.isBlank() && explanation.isBlank()) return@mapNotNull null
        val exampleArray = item.optJSONArray("examples")
        val examples = (0 until (exampleArray?.length() ?: 0)).mapNotNull { exampleIndex ->
            val example = exampleArray?.optJSONObject(exampleIndex) ?: return@mapNotNull null
            val en = example.cleanString("en")
            if (en.isBlank()) null else FocusWordExample(en = en, zh = example.cleanString("zh"))
        }
        GrammarPoint(
            id = item.cleanString("id"),
            title = title,
            pattern = item.cleanString("pattern"),
            explanation = explanation,
            commonError = item.cleanString("commonError"),
            examples = examples,
        )
    }
}

private val PassageAudioRefPattern = Regex("^/api/v1/media/audio/[a-fA-F0-9]{24}\\.(mp3|wav|m4a)$")

private fun JSONObject?.curriculumAudioRef(key: String): String? =
    this?.cleanString(key)?.takeIf { ref -> PassageAudioRefPattern.matches(ref) }

private fun JSONObject?.positiveSpeed(key: String, fallback: Double): Double {
    val value = this?.optDouble(key, fallback) ?: fallback
    return if (value.isFinite() && value > 0.0) value else fallback
}

private fun JSONObject.cleanString(key: String): String =
    optString(key, "").trim().takeUnless { it.isEmpty() || it == "null" }.orEmpty()
