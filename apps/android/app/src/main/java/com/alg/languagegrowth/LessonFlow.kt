package com.alg.languagegrowth

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import kotlin.math.roundToInt

/**
 * 课堂主流程：整篇 → 分句 → 重点词 → 语法 → 完形 → 完成。
 *
 * 门禁规则（纯函数，便于单测）：
 *  - 分句：单句评测 > 50 才进入下一句，最后一句读完进入重点词；
 *  - 重点词：同一个词累计 3 次 > 50 才换下一个词，最后一个词结束进入语法；
 *  - 语法：可重复收听，听完进入完形；完形退出后出现「完成这堂课」。
 */
internal const val LESSON_PASS_SCORE = 50.0
internal const val WORD_PASS_REQUIRED = 3

internal enum class LessonStage { PASSAGE, SENTENCE, WORDS, GRAMMAR, CLOZE, FINISH }

internal data class LessonFlowState(
    val stage: LessonStage = LessonStage.PASSAGE,
    val sentenceIndex: Int = 0,
    val wordIndex: Int = 0,
    val wordPasses: Int = 0,
)

/** 完形练习的界面状态与回调；由课堂宿主（MainActivity）持有，流里只负责展示。 */
internal data class LessonClozeBinding(
    val loading: Boolean,
    val grammar: List<ClozeGrammarPoint>,
    val items: List<ClozeItem>,
    val batchIndex: Int,
    val selections: Map<String, String>,
    val grade: ClozeGrade?,
    val error: String,
    val onSelect: (String, String) -> Unit,
    val onSubmit: () -> Unit,
    val onNext: (Int) -> Unit,
    val onExit: () -> Unit,
)

internal fun LessonFlowState.afterSentenceScore(
    score: Double,
    sentenceCount: Int,
    wordCount: Int,
): LessonFlowState {
    if (score <= LESSON_PASS_SCORE) return this
    val next = sentenceIndex + 1
    if (next < sentenceCount) return copy(sentenceIndex = next)
    return if (wordCount > 0) {
        copy(stage = LessonStage.WORDS, sentenceIndex = sentenceIndex, wordIndex = 0, wordPasses = 0)
    } else {
        copy(stage = LessonStage.GRAMMAR, wordPasses = 0)
    }
}

internal fun LessonFlowState.afterWordScore(score: Double, wordCount: Int): LessonFlowState {
    if (score <= LESSON_PASS_SCORE) return this
    val passes = wordPasses + 1
    if (passes < WORD_PASS_REQUIRED) return copy(wordPasses = passes)
    val next = wordIndex + 1
    return if (next < wordCount) {
        copy(wordIndex = next, wordPasses = 0)
    } else {
        copy(stage = LessonStage.GRAMMAR, wordPasses = 0)
    }
}

/** 重点词讲解稿：服务端已下发就用服务端的，旧数据用本地模板兜底。 */
internal fun FocusWord.lessonExplanation(): String {
    if (explanation.isNotBlank()) return explanation
    val posZh = when (pos.lowercase().trim().trimEnd('.')) {
        "n" -> "名词"
        "v", "vt", "vi" -> "动词"
        "adj" -> "形容词"
        "adv" -> "副词"
        "prep" -> "介词"
        "pron" -> "代词"
        "conj" -> "连词"
        "det" -> "限定词"
        else -> ""
    }
    val parts = mutableListOf<String>()
    parts += "${word}${if (posZh.isNotEmpty()) " 是$posZh" else ""}${if (meaningZh.isNotBlank()) "，意思是$meaningZh" else ""}。"
    parts += if (forms.isEmpty()) "这个词没有需要特别记的变形。" else "变形有 ${forms.joinToString("、")}。"
    examples.firstOrNull()?.let { example ->
        parts += "例句：${example.en}${if (example.zh.isNotBlank()) "。意思是：${example.zh}" else ""}。"
    }
    return parts.joinToString("")
}

/** 语法讲解稿：标题 + 形式 + 讲解 + 例句，重复收听时读同一段。 */
private fun grammarSpeech(point: GrammarPoint): String {
    val parts = mutableListOf<String>()
    if (point.title.isNotBlank()) parts += "${point.title}。"
    if (point.pattern.isNotBlank()) parts += "它的形式是：${point.pattern}。"
    if (point.explanation.isNotBlank()) parts += point.explanation
    point.examples.forEach { example ->
        parts += "例句：${example.en}${if (example.zh.isNotBlank()) "。意思是：${example.zh}" else ""}。"
    }
    return parts.joinToString("")
}

@Composable
internal fun LessonFlowHost(
    passage: LessonPassage,
    playingKey: String,
    busy: Boolean,
    playSentence: (PassageSentence, Boolean) -> Unit,
    playAll: (Boolean) -> Unit,
    playRef: (String) -> Unit,
    stopAudio: () -> Unit,
    speakText: (String) -> Unit,
    startRecording: () -> Boolean,
    stopRecording: () -> String?,
    evaluate: suspend (String, String, Long, Double?, Int) -> JSONObject,
    cloze: LessonClozeBinding,
    onEnterCloze: () -> Unit,
    onComplete: () -> Unit,
    onExit: () -> Unit,
) {
    val sentences = passage.sentences
    val words = passage.focusWords
    var state by remember(passage.unitId) { mutableStateOf(LessonFlowState()) }
    val scope = rememberCoroutineScope()

    var recording by remember { mutableStateOf(false) }
    var scoring by remember { mutableStateOf(false) }
    var score by remember { mutableStateOf<Double?>(null) }
    var feedback by remember { mutableStateOf("") }
    var attempt by remember { mutableStateOf(0) }
    var passed by remember { mutableStateOf(false) }
    var startedAt by remember { mutableStateOf(0L) }

    fun resetAttempts() {
        score = null
        feedback = ""
        attempt = 0
        passed = false
    }

    val currentTarget: String = when (state.stage) {
        LessonStage.SENTENCE -> sentences.getOrNull(state.sentenceIndex)?.english.orEmpty()
        LessonStage.WORDS -> words.getOrNull(state.wordIndex)?.word.orEmpty()
        else -> ""
    }

    val beginHold: () -> Unit = {
        stopAudio()
        scope.launch {
            if (recording || scoring) return@launch
            resetAttempts()
            if (!startRecording()) {
                feedback = "请允许麦克风权限后再跟读。"
                return@launch
            }
            startedAt = System.currentTimeMillis()
            recording = true
        }
    }

    val endHold: () -> Unit = {
        if (recording) {
            recording = false
            val path = stopRecording()
            if (path.isNullOrBlank()) {
                feedback = "这次录音没有保存好，再按住试一次。"
            } else {
                scope.launch {
                    scoring = true
                    try {
                        val encoded = withContext(Dispatchers.IO) {
                            android.util.Base64.encodeToString(File(path).readBytes(), android.util.Base64.NO_WRAP)
                        }
                        val duration = (System.currentTimeMillis() - startedAt).coerceAtLeast(300L)
                        val result = evaluate(encoded, currentTarget, duration, score, attempt + 1)
                        attempt += 1
                        val value = result.optDouble("score", Double.NaN)
                        if (value.isFinite()) {
                            score = value
                            passed = value > LESSON_PASS_SCORE
                            feedback = if (passed) {
                                "很好，${value.roundToInt()} 分，可以继续了。"
                            } else {
                                "${value.roundToInt()} 分，再清楚一点，超过 50 分就能继续。"
                            }
                        } else {
                            feedback = "老师没听清，再按住试一次。"
                        }
                    } catch (e: Exception) {
                        feedback = "评测没有成功，再按住试一次。"
                    } finally {
                        scoring = false
                    }
                }
            }
        }
    }

    // 过关后稍等一会儿再翻页，让孩子先看到分数。
    LaunchedEffect(passed, state.stage, state.sentenceIndex, state.wordIndex) {
        if (!passed) return@LaunchedEffect
        delay(1200)
        val value = score ?: return@LaunchedEffect
        state = when (state.stage) {
            LessonStage.SENTENCE -> state.afterSentenceScore(value, sentences.size, words.size)
            LessonStage.WORDS -> state.afterWordScore(value, words.size)
            else -> state
        }
        resetAttempts()
    }

    LessonHeader(
        stage = when (state.stage) {
            LessonStage.PASSAGE -> "第一步 · 读整篇"
            LessonStage.SENTENCE -> "第二步 · 分句跟读"
            LessonStage.WORDS -> "第三步 · 重点词汇"
            LessonStage.GRAMMAR -> "第四步 · 语法讲解"
            LessonStage.CLOZE -> "第五步 · 完形练习"
            LessonStage.FINISH -> "完成这堂课"
        },
        hint = when (state.stage) {
            LessonStage.SENTENCE -> "${state.sentenceIndex + 1}/${sentences.size.coerceAtLeast(1)} 句"
            LessonStage.WORDS -> "${state.wordIndex + 1}/${words.size.coerceAtLeast(1)} 词"
            else -> ""
        },
        onExit = {
            stopAudio()
            onExit()
        },
    )

    when (state.stage) {
        LessonStage.PASSAGE -> PassagePage(
            passage = passage,
            busy = busy,
            playingKey = playingKey,
            onPlayAll = playAll,
            onPlaySentence = playSentence,
            onNext = {
                state = state.copy(stage = LessonStage.SENTENCE, sentenceIndex = 0)
                resetAttempts()
            },
        )

        LessonStage.SENTENCE -> {
            val sentence = sentences.getOrNull(state.sentenceIndex)
            if (sentence == null) {
                state = state.copy(stage = if (words.isEmpty()) LessonStage.GRAMMAR else LessonStage.WORDS)
            } else {
                SentencePage(
                    sentence = sentence,
                    index = state.sentenceIndex,
                    total = sentences.size,
                    playingKey = playingKey,
                    busy = busy,
                    recording = recording,
                    scoring = scoring,
                    score = score,
                    feedback = feedback,
                    passed = passed,
                    onPlay = { slow -> playSentence(sentence, slow) },
                    onBegin = beginHold,
                    onEnd = endHold,
                )
            }
        }

        LessonStage.WORDS -> {
            val word = words.getOrNull(state.wordIndex)
            if (word == null) {
                state = state.copy(stage = LessonStage.GRAMMAR)
            } else {
                WordPage(
                    word = word,
                    index = state.wordIndex,
                    total = words.size,
                    passes = state.wordPasses,
                    busy = busy,
                    recording = recording,
                    scoring = scoring,
                    score = score,
                    feedback = feedback,
                    passed = passed,
                    onSpeak = { speakText(word.lessonExplanation()) },
                    onPlayWord = {
                        val ref = word.playableClips.firstOrNull { it.kind == "word" }?.audioRef
                            ?: word.playableClips.firstOrNull()?.audioRef
                        if (ref != null) playRef(ref)
                    },
                    onBegin = beginHold,
                    onEnd = endHold,
                )
            }
        }

        LessonStage.GRAMMAR -> GrammarPage(
            points = passage.grammar,
            sentences = sentences,
            busy = busy,
            onSpeak = speakText,
            onPlaySentence = playSentence,
            onStartCloze = {
                state = state.copy(stage = LessonStage.CLOZE)
                onEnterCloze()
            },
        )

        LessonStage.CLOZE -> ClozeScreen(
            grammar = cloze.grammar,
            items = cloze.items,
            loading = cloze.loading,
            batchIndex = cloze.batchIndex,
            selections = cloze.selections,
            grade = cloze.grade,
            error = cloze.error,
            onSelect = cloze.onSelect,
            onSubmit = cloze.onSubmit,
            onNext = cloze.onNext,
            onExit = {
                cloze.onExit()
                state = state.copy(stage = LessonStage.FINISH)
            },
        )

        LessonStage.FINISH -> FinishPage(
            onFinish = {
                stopAudio()
                onComplete()
            },
        )
    }
}

@Composable
private fun LessonHeader(stage: String, hint: String, onExit: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        GrowthTextButton("退出本节课程", onExit, emoji = "←")
        Spacer(Modifier.weight(1f))
        if (hint.isNotBlank()) {
            GrowthPill(hint, GrowthColors.PrimaryDeep, GrowthColors.PrimaryWash)
        }
    }
    Text(stage, style = MaterialTheme.typography.labelLarge, color = GrowthColors.InkSoft)
}

@Composable
private fun PassagePage(
    passage: LessonPassage,
    busy: Boolean,
    playingKey: String,
    onPlayAll: (Boolean) -> Unit,
    onPlaySentence: (PassageSentence, Boolean) -> Unit,
    onNext: () -> Unit,
) {
    var slow by remember { mutableStateOf(false) }
    val playing = playingKey.isNotBlank()

    GrowthCard(
        modifier = Modifier.fillMaxWidth(),
        fill = GrowthColors.BlueWash,
        outline = GrowthColors.Blue.copy(alpha = 0.22f),
    ) {
        GrowthSectionTitle("整篇课文", "📖")
        Text(passage.title, style = MaterialTheme.typography.titleLarge, color = GrowthColors.Ink)
        Text(
            "一行英语一行翻译，先听两遍，再一句一句跟读。",
            style = MaterialTheme.typography.bodySmall,
            color = GrowthColors.InkSoft,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GrowthSecondaryButton(
                if (!slow) "✓ 正常语速" else "正常语速",
                { slow = false },
                modifier = Modifier.weight(1f),
            )
            GrowthSecondaryButton(
                if (slow) "✓ 慢速" else "慢速",
                { slow = true },
                modifier = Modifier.weight(1f),
            )
        }
        GrowthPrimaryButton(
            if (playing) "播放中…" else "播放整篇",
            { onPlayAll(slow) },
            emoji = "▶",
            enabled = !busy,
        )
    }

    passage.paragraphs.forEach { paragraph ->
        GrowthCard(modifier = Modifier.fillMaxWidth()) {
            paragraph.sentences.forEach { sentence ->
                Text(
                    sentence.english,
                    style = MaterialTheme.typography.titleMedium,
                    color = GrowthColors.Ink,
                )
                if (sentence.chinese.isNotBlank()) {
                    Text(
                        sentence.chinese,
                        style = MaterialTheme.typography.bodyMedium,
                        color = GrowthColors.InkSoft,
                    )
                }
                GrowthTextButton("听这句", { onPlaySentence(sentence, slow) }, emoji = "🔊")
            }
        }
    }

    GrowthPrimaryButton("进入分句朗读", onNext, emoji = "🎤")
}

@Composable
private fun SentencePage(
    sentence: PassageSentence,
    index: Int,
    total: Int,
    playingKey: String,
    busy: Boolean,
    recording: Boolean,
    scoring: Boolean,
    score: Double?,
    feedback: String,
    passed: Boolean,
    onPlay: (Boolean) -> Unit,
    onBegin: () -> Unit,
    onEnd: () -> Unit,
) {
    val normalPlaying = playingKey == "${sentence.id}:normal"
    val slowPlaying = playingKey == "${sentence.id}:slow"
    GrowthCard(
        modifier = Modifier.fillMaxWidth(),
        fill = GrowthColors.BlueWash,
        outline = GrowthColors.Blue.copy(alpha = 0.22f),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            GrowthSectionTitle("分句跟读", "🎤")
            Spacer(Modifier.weight(1f))
            GrowthPill("${index + 1}/$total", GrowthColors.PrimaryDeep, GrowthColors.PrimaryWash)
        }
        Text(
            sentence.english,
            style = MaterialTheme.typography.titleLarge,
            lineHeight = 34.sp,
            color = GrowthColors.Ink,
        )
        if (sentence.chinese.isNotBlank()) {
            Text(sentence.chinese, style = MaterialTheme.typography.bodyMedium, color = GrowthColors.InkSoft)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GrowthSecondaryButton(
                if (normalPlaying) "▶ 正常" else "正常语速",
                { onPlay(false) },
                modifier = Modifier.weight(1f),
                enabled = !busy && sentence.audio.normalRef != null,
            )
            GrowthSecondaryButton(
                if (slowPlaying) "▶ 慢速" else "慢速",
                { onPlay(true) },
                modifier = Modifier.weight(1f),
                enabled = !busy && sentence.audio.slowRef != null,
            )
        }
        LessonHoldButton(recording = recording, enabled = !scoring, onPress = onBegin, onRelease = onEnd)
        if (scoring) {
            Text("老师正在听…", style = MaterialTheme.typography.bodySmall, color = GrowthColors.InkSoft)
        }
        if (feedback.isNotBlank()) {
            Text(feedback, style = MaterialTheme.typography.bodyMedium, color = GrowthColors.Ink)
        }
        if (passed) {
            Text(
                "超过 50 分，马上进入下一句 →",
                style = MaterialTheme.typography.labelLarge,
                color = GrowthColors.PrimaryDeep,
            )
        }
        Text(
            "这句超过 50 分才能进入下一句。",
            style = MaterialTheme.typography.bodySmall,
            color = GrowthColors.InkSoft,
        )
    }
}

@Composable
private fun WordPage(
    word: FocusWord,
    index: Int,
    total: Int,
    passes: Int,
    busy: Boolean,
    recording: Boolean,
    scoring: Boolean,
    score: Double?,
    feedback: String,
    passed: Boolean,
    onSpeak: () -> Unit,
    onPlayWord: () -> Unit,
    onBegin: () -> Unit,
    onEnd: () -> Unit,
) {
    GrowthCard(
        modifier = Modifier.fillMaxWidth(),
        fill = GrowthColors.SunWash,
        outline = GrowthColors.Sun.copy(alpha = 0.28f),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            GrowthSectionTitle("重点词汇", "⭐")
            Spacer(Modifier.weight(1f))
            GrowthPill("${index + 1}/$total", GrowthColors.SunDeep, GrowthColors.Surface)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(word.word, style = MaterialTheme.typography.headlineMedium, color = GrowthColors.Ink)
            Spacer(Modifier.width(10.dp))
            if (word.pos.isNotBlank()) {
                GrowthPill(word.pos, GrowthColors.PrimaryDeep, GrowthColors.PrimaryWash)
            }
        }
        if (word.phonetic.isNotBlank()) {
            Text(word.phonetic, style = MaterialTheme.typography.titleMedium, color = GrowthColors.InkSoft)
        }
        if (word.meaningZh.isNotBlank()) {
            Text(word.meaningZh, style = MaterialTheme.typography.titleMedium, color = GrowthColors.Ink)
        }

        Text("变形", style = MaterialTheme.typography.labelLarge, color = GrowthColors.InkSoft)
        if (word.forms.isEmpty()) {
            Text("这个词没有需要特别记的变形。", style = MaterialTheme.typography.bodyMedium, color = GrowthColors.InkSoft)
        } else {
            Text(word.forms.joinToString(" · "), style = MaterialTheme.typography.bodyLarge, color = GrowthColors.Ink)
        }

        if (word.examples.isNotEmpty()) {
            Text("例句", style = MaterialTheme.typography.labelLarge, color = GrowthColors.InkSoft)
            word.examples.forEach { example ->
                Text(example.en, style = MaterialTheme.typography.bodyLarge, color = GrowthColors.Ink)
                if (example.zh.isNotBlank()) {
                    Text(example.zh, style = MaterialTheme.typography.bodySmall, color = GrowthColors.InkSoft)
                }
            }
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            GrowthSecondaryButton(
                "🔊 听讲解",
                onSpeak,
                modifier = Modifier.weight(1f),
                enabled = !busy,
            )
            GrowthSecondaryButton(
                "播放单词",
                onPlayWord,
                modifier = Modifier.weight(1f),
                enabled = !busy && word.playableClips.isNotEmpty(),
            )
        }

        Text(
            "跟读通过 $passes/$WORD_PASS_REQUIRED 次",
            style = MaterialTheme.typography.labelLarge,
            color = GrowthColors.SunDeep,
        )
        LessonHoldButton(recording = recording, enabled = !scoring, onPress = onBegin, onRelease = onEnd)
        if (scoring) {
            Text("老师正在听…", style = MaterialTheme.typography.bodySmall, color = GrowthColors.InkSoft)
        }
        if (feedback.isNotBlank()) {
            Text(feedback, style = MaterialTheme.typography.bodyMedium, color = GrowthColors.Ink)
        }
        Text(
            "同一个词要跟读超过 50 分 $WORD_PASS_REQUIRED 次，才能进入下一个词。",
            style = MaterialTheme.typography.bodySmall,
            color = GrowthColors.InkSoft,
        )
    }
}

@Composable
private fun GrammarPage(
    points: List<GrammarPoint>,
    sentences: List<PassageSentence>,
    busy: Boolean,
    onSpeak: (String) -> Unit,
    onPlaySentence: (PassageSentence, Boolean) -> Unit,
    onStartCloze: () -> Unit,
) {
    if (points.isEmpty()) {
        GrowthCard(modifier = Modifier.fillMaxWidth()) {
            GrowthSectionTitle("语法讲解", "🧩")
            Text(
                "本节课没有额外的语法点，把课文读熟就是最好的语法练习。",
                style = MaterialTheme.typography.bodyMedium,
                color = GrowthColors.InkSoft,
            )
        }
    }
    points.forEach { point ->
        GrowthCard(
            modifier = Modifier.fillMaxWidth(),
            fill = GrowthColors.SunWash,
            outline = GrowthColors.Sun.copy(alpha = 0.28f),
        ) {
            GrowthSectionTitle(point.title.ifBlank { "语法" }, "🧩")
            if (point.pattern.isNotBlank()) {
                Text(point.pattern, style = MaterialTheme.typography.titleMedium, color = GrowthColors.Ink)
            }
            if (point.explanation.isNotBlank()) {
                Text(point.explanation, style = MaterialTheme.typography.bodyMedium, color = GrowthColors.InkSoft)
            }
            if (point.commonError.isNotBlank()) {
                Text(
                    "容易错：${point.commonError}",
                    style = MaterialTheme.typography.bodySmall,
                    color = GrowthColors.SunDeep,
                )
            }
            point.examples.forEach { example ->
                Text(example.en, style = MaterialTheme.typography.bodyLarge, color = GrowthColors.Ink)
                if (example.zh.isNotBlank()) {
                    Text(example.zh, style = MaterialTheme.typography.bodySmall, color = GrowthColors.InkSoft)
                }
                val matched = sentences.firstOrNull { it.english.trim().equals(example.en.trim(), ignoreCase = true) }
                if (matched != null) {
                    GrowthTextButton("听例句", { onPlaySentence(matched, false) }, emoji = "🔊")
                }
            }
            GrowthSecondaryButton(
                "重复收听讲解",
                { onSpeak(grammarSpeech(point)) },
                emoji = "🎧",
                enabled = !busy,
            )
        }
    }
    GrowthPrimaryButton("进入完形练习", onStartCloze, emoji = "✏️")
}

@Composable
private fun FinishPage(onFinish: () -> Unit) {
    GrowthCard(
        modifier = Modifier.fillMaxWidth(),
        fill = GrowthColors.SunWash,
        outline = GrowthColors.Sun.copy(alpha = 0.28f),
    ) {
        GrowthSectionTitle("这一课学完了", "🎉")
        Text(
            "读课文、分句跟读、重点词汇、语法讲解和完形练习都走完了。",
            style = MaterialTheme.typography.bodyMedium,
            color = GrowthColors.InkSoft,
        )
        Text(
            "点下面的按钮结束本节课。",
            style = MaterialTheme.typography.bodySmall,
            color = GrowthColors.InkSoft,
        )
    }
    GrowthPrimaryButton("完成这堂课", onFinish, emoji = "🎉")
}

/** 与现有课堂一致的按住说话按钮；文本单独一份，避免影响老页面。 */
@Composable
private fun LessonHoldButton(
    recording: Boolean,
    enabled: Boolean,
    onPress: () -> Unit,
    onRelease: () -> Unit,
) {
    var pressed by remember { mutableStateOf(false) }
    val active = pressed || recording
    Box(
        Modifier
            .fillMaxWidth()
            .height(64.dp)
            .clip(GrowthShapes.Button)
            .background(if (active) GrowthColors.Primary.copy(alpha = 0.78f) else GrowthColors.Primary)
            .pointerInput(enabled) {
                if (!enabled) return@pointerInput
                detectTapGestures(
                    onPress = {
                        pressed = true
                        onPress()
                        tryAwaitRelease()
                        pressed = false
                        onRelease()
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Text(
            if (active) "松开，老师听听" else "按住跟读",
            style = MaterialTheme.typography.labelLarge,
            color = Color.White,
        )
    }
}
