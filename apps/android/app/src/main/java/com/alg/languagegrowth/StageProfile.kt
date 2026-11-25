package com.alg.languagegrowth

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject

/**
 * P3-03：七领域阶段画像的客户端解析与展示。
 *
 * 数据来自 `/user/dashboard` 的 `stageProfile` 增量字段，口径是
 * `StageProfileService` 的 growthStage（0—6），不是 `abilities` 的
 * masteryCode（0—4），不能互相替代。
 *
 * 产品约束（任务书 §10.1 / §10.6）：
 *  - 七条线独立计算，不是总等级；
 *  - 某领域低不阻塞其他领域；
 *  - 阶段只作展示与规划参考，不作为课程解锁门槛。
 */
data class StageProfileRow(
    val key: String,
    val label: String,
    val emoji: String,
    val stage: Int,
    val nodeCount: Int,
    val evidenceCount: Int,
    val tint: Color,
    val wash: Color,
)

data class StageProfileView(
    val computedAt: String,
    val rows: List<StageProfileRow>,
)

private data class StageDomain(
    val key: String,
    val label: String,
    val emoji: String,
    val tint: Color,
    val wash: Color,
)

private val STAGE_DOMAINS = listOf(
    StageDomain("listening", "听力", "👂", GrowthColors.BlueDeep, GrowthColors.BlueWash),
    StageDomain("pronunciation", "发音", "🗣️", GrowthColors.PrimaryDeep, GrowthColors.PrimaryWash),
    StageDomain("vocabulary", "词汇", "🧠", GrowthColors.GrapeDeep, GrowthColors.GrapeWash),
    StageDomain("grammar", "语法", "📐", GrowthColors.MintDeep, GrowthColors.MintWash),
    StageDomain("speaking", "口语", "💬", GrowthColors.BlueDeep, GrowthColors.BlueWash),
    StageDomain("communication", "交流", "🤝", GrowthColors.GrapeDeep, GrowthColors.GrapeWash),
    StageDomain("schoolEnglish", "学校英语", "🏫", GrowthColors.SunDeep, GrowthColors.SunWash),
)

fun stageProfileLabel(stage: Int): String =
    if (stage <= 0) "尚未开始" else "阶段 $stage"

fun parseStageProfile(raw: JSONObject?): StageProfileView? {
    val stages = raw?.optJSONObject("stages") ?: return null
    val nodeCounts = raw.optJSONObject("stageNodeCounts")
    val evidenceCounts = raw.optJSONObject("evidenceCounts")
    val rows = STAGE_DOMAINS.map { domain ->
        StageProfileRow(
            key = domain.key,
            label = domain.label,
            emoji = domain.emoji,
            stage = stages.optInt(domain.key, 0).coerceIn(0, 6),
            nodeCount = nodeCounts?.optInt(domain.key, 0) ?: 0,
            evidenceCount = evidenceCounts?.optInt(domain.key, 0) ?: 0,
            tint = domain.tint,
            wash = domain.wash,
        )
    }
    return StageProfileView(
        computedAt = raw.optString("computedAt"),
        rows = rows,
    )
}

@Composable
fun StageProfileCard(profile: StageProfileView?, modifier: Modifier = Modifier) {
    GrowthCard(modifier = modifier.fillMaxWidth()) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            GrowthSectionTitle("七领域阶段", "🌈")
            Spacer(Modifier.weight(1f))
            GrowthPill("家长可见", GrowthColors.ForestDeep, GrowthColors.ForestWash, emoji = "👨‍👩‍👧")
        }
        if (profile == null) {
            Text(
                "阶段画像暂时不可用，请刷新后重试。",
                style = MaterialTheme.typography.bodyMedium,
                color = GrowthColors.InkSoft,
            )
            return@GrowthCard
        }
        Text(
            "每条线按能力独立计算，不是总等级；某领域低不会锁住其他领域。",
            style = MaterialTheme.typography.bodySmall,
            color = GrowthColors.InkSoft,
        )
        profile.rows.forEach { row ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(vertical = 7.dp),
                verticalAlignment = Alignment.Top,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(row.emoji, fontSize = 18.sp)
                Column(
                    Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            row.label,
                            style = MaterialTheme.typography.titleSmall,
                            color = GrowthColors.Ink,
                        )
                        Spacer(Modifier.weight(1f))
                        GrowthPill(stageProfileLabel(row.stage), row.tint, row.wash)
                    }
                    StageSegments(row.stage, row.tint)
                    Text(
                        "当前阶段 ${row.nodeCount} 个能力节点 · 累计 ${row.evidenceCount} 条证据",
                        style = MaterialTheme.typography.bodySmall,
                        color = GrowthColors.InkSoft,
                    )
                }
            }
        }
        Text(
            "阶段只作展示与规划参考，不作为课程解锁门槛。",
            style = MaterialTheme.typography.bodySmall,
            color = GrowthColors.InkSoft,
        )
    }
}

@Composable
private fun StageSegments(stage: Int, tint: Color, modifier: Modifier = Modifier) {
    val filled = stage.coerceIn(0, 6)
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        repeat(6) { index ->
            Box(
                Modifier
                    .weight(1f)
                    .height(8.dp)
                    .clip(GrowthShapes.Pill)
                    .background(if (index < filled) tint else tint.copy(alpha = 0.16f)),
            )
        }
    }
}
