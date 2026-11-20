package com.alg.languagegrowth

import org.json.JSONObject

/**
 * P2-06 重点词慢速拆读。
 *
 * 服务端已经按「整词 → 音节 → 音素 → 合成 → 自然语速」生成片段顺序
 * （`curriculumPassage.focusWords[].clips[]`），客户端只负责：
 *  1. 按 position 顺序播放并高亮当前单位；
 *  2. 发音评估指出错误音节/音素时，只练出错的部分，不要求整词盲目重读；
 *  3. 最多陪练 5 轮；连续不达标先降难度（只练错音、只读音节），不催促。
 *
 * 这里只放可单测的纯逻辑，Compose 只做渲染。
 */
internal const val FOCUS_DRILL_MAX_ROUNDS = 5

internal data class FocusWordClip(
    val key: String,
    val kind: String,
    val partIndex: Int,
    val position: Int,
    val speedTier: String,
    val text: String,
    val audioRef: String?,
    val status: String,
)

internal data class FocusWordExample(
    val en: String,
    val zh: String,
)

internal data class FocusWord(
    val word: String,
    val phonetic: String,
    /** P2 词性；词库无记录时为空。 */
    val pos: String = "",
    val meaningZh: String,
    /** P2 例句（单元词条自带的英中对照），最多 3 条。 */
    val examples: List<FocusWordExample> = emptyList(),
    /** 变形（复数/过去式/比较级等）；词库无记录时为空。 */
    val forms: List<String> = emptyList(),
    /** 中文语音讲解稿：词性、含义、变形规则、例句。 */
    val explanation: String = "",
    val syllables: List<String>,
    val difficultPhonemes: List<String>,
    val reason: String,
    val clips: List<FocusWordClip>,
) {
    /** 可播放片段；没有音频引用的片段不展示播放按钮，避免点不动。 */
    val playableClips: List<FocusWordClip>
        get() = clips.filter { it.audioRef != null }.sortedBy { it.position }
}

internal data class FocusDrillStep(
    val clip: FocusWordClip,
    /** 给孩子看的中文标签，例如「音节 1」「音素 /æ/」「合起来」。 */
    val label: String,
)

/** 解析课文教学包中的 focusWords；字段缺失时保持空，不影响课文正文展示。 */
internal fun parseFocusWords(raw: JSONObject?): List<FocusWord> {
    val array = raw?.optJSONArray("focusWords") ?: return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        parseFocusWord(array.optJSONObject(index))
    }
}

internal fun parseFocusWord(raw: JSONObject?): FocusWord? {
    if (raw == null) return null
    val word = raw.optString("word", "").trim()
    if (word.isEmpty()) return null
    return FocusWord(
        word = word,
        phonetic = raw.optString("phonetic", "").trim(),
        pos = raw.optString("pos", "").trim(),
        meaningZh = raw.optString("meaningZh", "").trim(),
        examples = parseFocusWordExamples(raw.optJSONArray("examples")),
        forms = raw.stringList("forms"),
        explanation = raw.optString("explanation", "").trim(),
        syllables = raw.stringList("syllables"),
        difficultPhonemes = raw.stringList("difficultPhonemes"),
        reason = raw.optString("reason", "").trim(),
        clips = parseFocusWordClips(raw.optJSONArray("clips")),
    )
}

private fun parseFocusWordExamples(array: org.json.JSONArray?): List<FocusWordExample> {
    if (array == null) return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        val item = array.optJSONObject(index) ?: return@mapNotNull null
        val en = item.optString("en", "").trim()
        if (en.isEmpty()) null else FocusWordExample(en = en, zh = item.optString("zh", "").trim())
    }
}

private fun parseFocusWordClips(array: org.json.JSONArray?): List<FocusWordClip> {
    if (array == null) return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        val item = array.optJSONObject(index) ?: return@mapNotNull null
        val key = item.optString("key", "").trim()
        val text = item.optString("text", "").trim()
        val kind = item.optString("kind", "").trim()
        if (key.isEmpty() || text.isEmpty() || kind.isEmpty()) return@mapNotNull null
        val ref = item.optString("audioRef", "").trim()
        FocusWordClip(
            key = key,
            kind = kind,
            partIndex = item.optInt("partIndex", 0).coerceAtLeast(0),
            position = item.optInt("position", index).coerceAtLeast(0),
            speedTier = item.optString("speedTier", "slow").trim().ifEmpty { "slow" },
            text = text,
            audioRef = ref.takeIf { it.startsWith("/") || it.startsWith("https://") },
            status = item.optString("status", "ready").trim().ifEmpty { "ready" },
        )
    }
}

private fun JSONObject.stringList(key: String): List<String> {
    val array = optJSONArray(key) ?: return emptyList()
    return (0 until array.length()).mapNotNull { index ->
        array.optString(index, "").trim().takeIf { it.isNotEmpty() }
    }
}

/**
 * 本轮要练的片段。
 *
 * - 没有错误定位时，按服务端顺序走完整五段（整词 → 音节 → 音素 → 合成 → 自然）；
 * - 评估指出具体音素/音节时，只练这些单位 + 合起来 + 自然语速，
 *   避免整词盲目重读（任务书 §7.2）。
 */
internal fun focusDrillSteps(word: FocusWord, errorUnits: List<String> = emptyList()): List<FocusDrillStep> {
    val playable = word.playableClips
    if (playable.isEmpty()) return emptyList()
    val normalizedErrors = errorUnits.map { normalizeUnit(it) }.filter { it.isNotEmpty() }
    val selected = if (normalizedErrors.isEmpty()) {
        playable
    } else {
        val matched = playable.filter { clip ->
            (clip.kind == "syllable" || clip.kind == "phoneme") &&
                normalizedErrors.any { error -> normalizeUnit(clip.text).contains(error) }
        }
        if (matched.isEmpty()) {
            // 定位不到具体单位时退回整词 + 自然语速，不做无依据的猜测。
            playable.filter { it.kind == "word" || it.kind == "natural" }.ifEmpty { playable }
        } else {
            val tail = playable.filter { it.kind == "blend" || it.kind == "natural" }
            (matched + tail).distinctBy { it.key }.sortedBy { it.position }
        }
    }
    return selected.map { FocusDrillStep(it, clipLabel(it)) }
}

internal fun clipLabel(clip: FocusWordClip): String = when (clip.kind) {
    "word" -> "整词"
    "syllable" -> "音节 ${clip.partIndex + 1}"
    "phoneme" -> "音素 ${clip.text}"
    "blend" -> "合起来"
    "natural" -> "自然语速"
    else -> clip.text
}

/** 去掉空格、斜杠和重音符号，便于把评估结果与片段文本对齐。 */
internal fun normalizeUnit(value: String): String =
    value.lowercase().filter { it.isLetter() || it == 'ː' }

/**
 * 陪练轮次推进：最多 5 轮。
 *
 * 第 3 轮起仍不达标时降级为「只练错音/只读音节」，而不是让孩子重复整词；
 * 返回 5 表示这一轮结束、不再自动重试（由孩子自己决定要不要再听）。
 */
internal fun nextDrillRound(current: Int, passedNow: Boolean): Int =
    if (passedNow) current else (current + 1).coerceAtMost(FOCUS_DRILL_MAX_ROUNDS)

internal fun drillStatusText(round: Int, passed: Boolean, score: Double?): String = when {
    passed -> "这一遍读得很清楚，可以继续下一句啦。"
    round <= 2 -> "不着急，先听老师慢慢读，再跟着读一遍。"
    round < FOCUS_DRILL_MAX_ROUNDS -> "我们只练刚才不太顺的那个音，慢慢来。"
    else -> "今天先练到这里，明天再试一次也来得及。"
}
