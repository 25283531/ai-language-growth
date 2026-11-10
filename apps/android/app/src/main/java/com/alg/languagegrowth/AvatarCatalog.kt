package com.alg.languagegrowth

/*
 * ============================================================================
 * 本地头像目录 / 等级解锁 / 头像选择器
 * ----------------------------------------------------------------------------
 * 基础头像 24 个：res/drawable/avatar_basic_01..24.xml
 *   来源 DiceBear 9.x "Open Peeps" 风格（Pablo Stanley），CC0 1.0，无需署名。
 *   由官方 HTTP API 取得 SVG 后转换为 Android VectorDrawable，全部本地资源，
 *   运行时零网络加载。来源与许可证见 apps/android/README.md。
 * 立体头像 10 个：纯 Compose Canvas 自绘伪 3D（径向渐变 + 高光 + 投影 +
 *   暗边），零外部资源、零积分、零第三方依赖。
 *
 * 解锁数量**直接读取服务端 dashboard 顶层的 `unlockedCount`**，取前 N 个可用；
 * 字段缺失（旧后端）回退默认值 **24**（24 个基础头像全开）。客户端**不重算
 * S / tier / 曲线**、不判定等级、不推断能力、不持久化解锁状态（D-024 教学逻辑与
 * 客户端分离）；档位只作展示，必须显示后端下发的免责说明，calibrated 缺失按未校准。
 * 曲线（后端）：`unlockedCount = 24 + min(2 * ceil(tier / 3), 10)`；
 * tier 0 → 24，1–3 → 26，4–6 → 28，7–9 → 30，10–12 → 32，13–14 → 34。
 * 主理人裁定契约：总数 34 = 24 基础 + 10 个 3D，固定顺序 [b00..b23, d00..d09]，
 * 3D 排在最后作为高阶奖励；本地标识 `preset://bNN` / `preset://dNN`。
 * 选中头像写入现有 PUT /user/profile 的 avatarUrl 字段（后端已放宽允许 preset://）；
 * 历史外链按中性占位处理，不崩、不加载网络。
 * ============================================================================
 */

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/* ------------------------------------------------------------------ Catalog */

data class AvatarItem(
    val id: String,
    val label: String,
    val index: Int,
    val is3D: Boolean,
)

private val BASIC_DRAWABLES = intArrayOf(
    R.drawable.avatar_basic_01, R.drawable.avatar_basic_02, R.drawable.avatar_basic_03,
    R.drawable.avatar_basic_04, R.drawable.avatar_basic_05, R.drawable.avatar_basic_06,
    R.drawable.avatar_basic_07, R.drawable.avatar_basic_08, R.drawable.avatar_basic_09,
    R.drawable.avatar_basic_10, R.drawable.avatar_basic_11, R.drawable.avatar_basic_12,
    R.drawable.avatar_basic_13, R.drawable.avatar_basic_14, R.drawable.avatar_basic_15,
    R.drawable.avatar_basic_16, R.drawable.avatar_basic_17, R.drawable.avatar_basic_18,
    R.drawable.avatar_basic_19, R.drawable.avatar_basic_20, R.drawable.avatar_basic_21,
    R.drawable.avatar_basic_22, R.drawable.avatar_basic_23, R.drawable.avatar_basic_24,
)

object AvatarCatalog {
    const val BASIC_COUNT = 24
    const val THREE_D_COUNT = 10

    /** 主理人裁定：固定顺序 AVATAR_ORDER = [b00..b23, d00..d09]，3D 排在最后。 */
    private val SHORT_BASIC = Regex("^preset://b(\\d{2})$")
    private val SHORT_3D = Regex("^preset://d(\\d{2})$")

    val items: List<AvatarItem> = buildList {
        repeat(BASIC_COUNT) { i ->
            val n = i.toString().padStart(2, '0')
            add(AvatarItem("preset://b$n", "基础头像 ${i + 1}", i, false))
        }
        repeat(THREE_D_COUNT) { i ->
            val n = i.toString().padStart(2, '0')
            add(AvatarItem("preset://d$n", "立体头像 ${i + 1}", BASIC_COUNT + i, true))
        }
    }

    fun isPreset(id: String): Boolean = id.startsWith("preset://")

    /**
     * 主格式 preset://bNN（0-based）；兼容本轮两种历史写法
     * preset://avatar/basic_NN 与 preset://basic/N（均为 1-based）。
     * 统一返回 1-based 序号，供 BASIC_DRAWABLES 索引。
     */
    private fun basicIndex(id: String): Int? {
        SHORT_BASIC.matchEntire(id)?.let { return it.groupValues[1].toInt() + 1 }
        return when {
            id.startsWith("preset://avatar/basic_") -> id.removePrefix("preset://avatar/basic_").toIntOrNull()
            id.startsWith("preset://basic/") -> id.removePrefix("preset://basic/").toIntOrNull()
            else -> null
        }
    }

    private fun threeDIndex(id: String): Int? {
        SHORT_3D.matchEntire(id)?.let { return it.groupValues[1].toInt() + 1 }
        return when {
            id.startsWith("preset://avatar/3d_") -> id.removePrefix("preset://avatar/3d_").toIntOrNull()
            id.startsWith("preset://3d/") -> id.removePrefix("preset://3d/").toIntOrNull()
            else -> null
        }
    }

    fun labelOf(id: String): String = when {
        basicIndex(id) != null -> "基础头像 ${basicIndex(id)}"
        threeDIndex(id) != null -> "立体头像 ${threeDIndex(id)}"
        id.isBlank() -> "尚未选择头像"
        else -> "自定义头像链接"
    }

    /** 返回该本地标识对应的 drawable 资源 id；3D / 历史外链返回 null，由 Canvas 或占位图渲染。 */
    fun basicDrawable(id: String): Int? = basicIndex(id)?.let { BASIC_DRAWABLES.getOrNull(it - 1) }

    fun threeDVariant(id: String): Int? = threeDIndex(id)?.coerceIn(1, THREE_D_COUNT)
}

/* ---------------------------------------------------------- Unlock policy */

/**
 * 展示侧只读取后端结果，**不重算任何等级 / 曲线**。
 * 主理人裁定：`unlockedCount = 24 + min(2 * ceil(tier / 3), 10)`、
 * `S = Σclamp(stage,0,4)`、`tier = clamp(floor(S/2),0,14)` 全部由后端推导；
 * 客户端只做「取前 unlockedCount 个」。24 个基础头像在 tier 0 即全部可选，
 * 10 个立体头像随档位每 3 档解锁 2 个，tier 14 时 34 个全解锁。
 * 解锁状态纯推导、不写 SharedPreferences、不写库、不做事件累加，重复刷新天然幂等。
 */
object AvatarUnlockPolicy {
    /** 旧后端 / 字段缺失 / 越界时的回退值：24（24 个基础头像全开）。 */
    const val FALLBACK_UNLOCKED = 24
    /** 每次解锁的立体头像数（后端曲线步长，仅用于中性文案）。 */
    const val UNLOCK_STEP = 2
    const val TOTAL = AvatarCatalog.BASIC_COUNT + AvatarCatalog.THREE_D_COUNT  // 34

    /** 契约 CEFR_LEVEL_NOTICE，展示档位时必须原样可见（后端未下发时的兜底）。 */
    const val DEFAULT_NOTICE =
        "参考档位由服务端按能力阶段推导；能力阈值未经真实儿童样本校准，仅供教学参考，不代表掌握，也不是官方 CEFR 认证或考试等级。客户端不得把参考档位表述为掌握结论或等级达成结论。"

    const val DISPLAY_UNCALIBRATED = "参考档位 · 未校准 · 不代表掌握"
    const val DISPLAY_CALIBRATED = "参考档位"

    /** 只读取 unlockedCount；缺失 / 非数字 / 越界一律回退 24，绝不读取 avatarTier 自行推算。 */
    fun unlockedOf(data: JSONObject?): Int {
        val count = data?.opt("unlockedCount") as? Number ?: return FALLBACK_UNLOCKED
        val n = count.toInt()
        return if (n in FALLBACK_UNLOCKED..TOTAL) n else FALLBACK_UNLOCKED
    }

    fun progress(data: JSONObject?): JSONObject? = data?.optJSONObject("levelProgress")

    /** calibrated 缺失按未校准；兼容 levelProgress.calibrated、顶层 calibrated、provisional（反义）。 */
    fun isCalibrated(data: JSONObject?): Boolean {
        val p = progress(data)
        val explicit = (p?.opt("calibrated") ?: data?.opt("calibrated")) as? Boolean
        if (explicit != null) return explicit
        val provisional = p?.opt("provisional") as? Boolean
        if (provisional != null) return !provisional
        return false
    }

    /** 后端 displayLabel 优先；缺失时按 calibrated 选中性措辞，绝不出现「已掌握 / 已达到 A1」。 */
    fun displayLabel(data: JSONObject?): String {
        val fromServer = progress(data)?.optString("displayLabel").orEmpty()
        if (fromServer.isNotBlank() && fromServer != "null") return fromServer
        return if (isCalibrated(data)) DISPLAY_CALIBRATED else DISPLAY_UNCALIBRATED
    }

    fun notice(data: JSONObject?): String =
        progress(data)?.optString("notice").orEmpty().ifBlank { DEFAULT_NOTICE }

    /**
     * 下一次「新增头像」的预告，来自 `levelProgress.next.unlockAhead`
     * （`{ tier, inTiers, additional } | null`）。
     *
     * 新曲线下相邻档位不一定新增头像（例如 tier 7→8 本档不增，下一次新增在 tier 10），
     * 因此**不能**直接用 `next.additionalUnlocks` 生成「升一级解锁 N 个」的文案——
     * 该值可能为 0。返回 null 表示没有可预告的新增（已解锁满或字段缺失），
     * 由 UI 选中性兜底文案，绝不承诺具体数量。
     */
    fun unlockAhead(data: JSONObject?): UnlockAhead? {
        val ahead = progress(data)?.optJSONObject("next")?.optJSONObject("unlockAhead") ?: return null
        val tier = ahead.optInt("tier", -1)
        val tiers = ahead.optInt("inTiers", 0)
        val additional = ahead.optInt("additional", 0)
        if (tier < 0 || tiers <= 0 || additional <= 0) return null
        return UnlockAhead(tier = tier, tiers = tiers, additional = additional)
    }
}

/** 下一次新增头像的预告：还需 [tiers] 档到达 [tier] 档，可解锁 [additional] 个立体头像。 */
data class UnlockAhead(val tier: Int, val tiers: Int, val additional: Int)

/* ------------------------------------------------------------- Art / 3D */

private data class Palette3D(
    val light: Color,
    val base: Color,
    val dark: Color,
    val bgLight: Color,
    val bg: Color,
    val accent: Color,
)

/** 10 组自绘立体头像配色，取自 GrowthColors 主色系，儿童主题全彩、成人主题底色收敛。 */
private val PALETTES_3D = listOf(
    Palette3D(Color(0xFFFFC3AE), GrowthColors.Primary, GrowthColors.PrimaryDeep, Color(0xFFFFF4EC), GrowthColors.PrimaryWash, GrowthColors.Sun),
    Palette3D(Color(0xFFB7D8FF), GrowthColors.Blue, GrowthColors.BlueDeep, Color(0xFFF2F8FF), GrowthColors.BlueWash, GrowthColors.Sun),
    Palette3D(Color(0xFFFFE39A), GrowthColors.Sun, GrowthColors.SunDeep, Color(0xFFFFFAE9), GrowthColors.SunWash, GrowthColors.Primary),
    Palette3D(Color(0xFFA8E4C9), GrowthColors.Mint, GrowthColors.MintDeep, Color(0xFFF0FBF5), GrowthColors.MintWash, GrowthColors.Pink),
    Palette3D(Color(0xFFD6C4FA), GrowthColors.Grape, GrowthColors.GrapeDeep, Color(0xFFF8F3FF), GrowthColors.GrapeWash, GrowthColors.Sun),
    Palette3D(Color(0xFFFFC1D8), GrowthColors.Pink, GrowthColors.PrimaryDeep, Color(0xFFFFF3F7), Color(0xFFFFE8F0), GrowthColors.Mint),
    Palette3D(Color(0xFF9FE0D0), Color(0xFF2FA98F), GrowthColors.MintDeep, Color(0xFFEFFBF7), GrowthColors.MintWash, GrowthColors.Sun),
    Palette3D(Color(0xFFFFD2A6), Color(0xFFF09A3E), Color(0xFFA85B14), Color(0xFFFFF6E8), GrowthColors.PrimaryWash, GrowthColors.Blue),
    Palette3D(Color(0xFFB9CDF7), Color(0xFF6E8FD8), Color(0xFF334F92), Color(0xFFF1F5FF), GrowthColors.BlueWash, GrowthColors.Pink),
    Palette3D(Color(0xFFF9C5D2), Color(0xFFE27C9B), Color(0xFF9A3F5C), Color(0xFFFFF2F6), Color(0xFFFFE8F0), GrowthColors.Mint),
)

private fun starPathLocal(center: Offset, outer: Float, inner: Float): Path {
    val path = Path()
    for (i in 0 until 10) {
        val radius = if (i % 2 == 0) outer else inner
        val angle = -PI / 2 + i * PI / 5
        val x = center.x + (cos(angle) * radius).toFloat()
        val y = center.y + (sin(angle) * radius).toFloat()
        if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
    }
    path.close()
    return path
}

private fun DrawScope.drawThreeD(p: Palette3D, variant: Int, child: Boolean) {
    val s = size.minDimension
    val cx = size.width / 2f
    val cy = size.height / 2f
    val bgLight = if (child) p.bgLight else GrowthColors.Surface
    val bg = if (child) p.bg else GrowthColors.ForestWash
    val ink = GrowthColors.Ink

    // 背景径向渐变（伪 3D 舞台感）
    drawCircle(
        Brush.radialGradient(listOf(bgLight, bg), center = Offset(cx, cy), radius = s * 0.72f),
        radius = s / 2f, center = Offset(cx, cy),
    )
    // 地面软投影
    drawOval(
        ink.copy(alpha = 0.12f),
        topLeft = Offset(cx - s * 0.24f, cy + s * 0.29f),
        size = Size(s * 0.48f, s * 0.075f),
    )

    val r = s * 0.28f
    val head = Offset(cx, cy - s * 0.035f)

    // 外圈柔光
    drawCircle(p.base.copy(alpha = 0.22f), radius = r * 1.18f, center = head, style = Stroke(width = s * 0.03f))
    // 主体球：左上亮、右下暗的径向渐变模拟体积
    drawCircle(
        Brush.radialGradient(
            listOf(p.light, p.base, p.dark),
            center = Offset(head.x - r * 0.38f, head.y - r * 0.45f),
            radius = r * 1.75f,
        ),
        radius = r, center = head,
    )
    // 暗边勾勒轮廓
    drawCircle(p.dark.copy(alpha = 0.42f), radius = r, center = head, style = Stroke(width = s * 0.012f))
    // 高光：左上椭圆主高光 + 右侧小点高光
    drawOval(
        Color.White.copy(alpha = 0.55f),
        topLeft = Offset(head.x - r * 0.58f, head.y - r * 0.66f),
        size = Size(r * 0.52f, r * 0.30f),
    )
    drawCircle(Color.White.copy(alpha = 0.30f), radius = r * 0.09f, center = Offset(head.x + r * 0.46f, head.y - r * 0.36f))

    // 眼睛 + 白色眼神光
    val eyeY = head.y - r * 0.05f
    val eyeDx = r * 0.31f
    drawCircle(ink, radius = s * 0.027f, center = Offset(head.x - eyeDx, eyeY))
    drawCircle(ink, radius = s * 0.027f, center = Offset(head.x + eyeDx, eyeY))
    drawCircle(Color.White, radius = s * 0.009f, center = Offset(head.x - eyeDx + s * 0.009f, eyeY - s * 0.009f))
    drawCircle(Color.White, radius = s * 0.009f, center = Offset(head.x + eyeDx + s * 0.009f, eyeY - s * 0.009f))
    // 腮红
    drawCircle(p.accent.copy(alpha = 0.42f), radius = s * 0.034f, center = Offset(head.x - r * 0.55f, head.y + r * 0.22f))
    drawCircle(p.accent.copy(alpha = 0.42f), radius = s * 0.034f, center = Offset(head.x + r * 0.55f, head.y + r * 0.22f))
    // 微笑
    val mw = r * 0.55f
    drawArc(
        ink, startAngle = 0f, sweepAngle = 180f, useCenter = false,
        topLeft = Offset(head.x - mw / 2f, head.y + r * 0.10f),
        size = Size(mw, r * 0.40f),
        style = Stroke(width = s * 0.016f, cap = StrokeCap.Round),
    )

    // 头顶装饰：4 种形态轮转，让 10 个头像彼此可区分
    when (variant % 4) {
        0 -> drawPath(
            starPathLocal(Offset(cx, head.y - r * 1.30f), s * 0.075f, s * 0.032f),
            p.accent,
        )
        1 -> {
            drawCircle(p.base, radius = s * 0.062f, center = Offset(head.x - r * 0.86f, head.y - r * 0.80f))
            drawCircle(p.base, radius = s * 0.062f, center = Offset(head.x + r * 0.86f, head.y - r * 0.80f))
            drawCircle(p.light, radius = s * 0.030f, center = Offset(head.x - r * 0.86f, head.y - r * 0.80f))
            drawCircle(p.light, radius = s * 0.030f, center = Offset(head.x + r * 0.86f, head.y - r * 0.80f))
        }
        2 -> {
            drawLine(
                p.dark, Offset(cx, head.y - r * 0.98f), Offset(cx, head.y - r * 1.36f),
                strokeWidth = s * 0.020f, cap = StrokeCap.Round,
            )
            drawCircle(p.accent, radius = s * 0.055f, center = Offset(cx, head.y - r * 1.44f))
        }
        else -> {
            drawCircle(p.accent, radius = s * 0.075f, center = Offset(cx, head.y - r * 1.28f))
            drawCircle(bgLight, radius = s * 0.065f, center = Offset(cx + s * 0.035f, head.y - r * 1.34f))
        }
    }
}

/** 单个头像绘制：本地 VectorDrawable / 自绘伪 3D / 历史外链中性占位，均不发起网络请求。 */
@Composable
fun AvatarArt(id: String, size: Dp, modifier: Modifier = Modifier) {
    val drawable = AvatarCatalog.basicDrawable(id)
    val variant = AvatarCatalog.threeDVariant(id)
    when {
        drawable != null -> Image(
            painter = painterResource(drawable),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = modifier.size(size).clip(GrowthShapes.Pill),
        )
        variant != null -> {
            val child = LocalChildTheme.current
            val palette = PALETTES_3D[(variant - 1) % PALETTES_3D.size]
            Canvas(modifier.size(size).clip(GrowthShapes.Pill)) {
                drawThreeD(palette, variant, child)
            }
        }
        else -> Box(
            modifier.size(size).clip(GrowthShapes.Pill).background(GrowthColors.Cream),
            contentAlignment = Alignment.Center,
        ) { Text("🧑", fontSize = 26.sp) }
    }
}

/* ----------------------------------------------------------------- Picker */

@Composable
private fun RowScope.AvatarTile(
    item: AvatarItem,
    locked: Boolean,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val child = LocalChildTheme.current
    // 中性锁定文案（主理人裁定）：不出现具体档位名，避免「已达到 A1」类表述
    val text = when {
        selected -> "✅ 已选用"
        locked -> "升到下一档解锁"
        else -> "可选"
    }
    val spoken = when {
        selected -> "${item.label}，已选用"
        locked -> "${item.label}，升到下一档解锁"
        else -> "${item.label}，可选"
    }
    val borderColor = if (selected) (if (child) GrowthColors.Primary else GrowthColors.Forest) else GrowthColors.Outline
    val background = if (selected) {
        if (child) GrowthColors.PrimaryWash else GrowthColors.ForestWash
    } else GrowthColors.Surface
    val textColor = when {
        selected -> if (child) GrowthColors.PrimaryDeep else GrowthColors.ForestDeep
        locked -> GrowthColors.InkSoft
        else -> GrowthColors.Ink
    }
    Column(
        Modifier
            .weight(1f)
            .heightIn(min = 96.dp)   // 显式 ≥48dp 触控目标
            .clip(GrowthShapes.CardSmall)
            .background(background)
            .border(if (selected) 2.dp else 1.5.dp, borderColor, GrowthShapes.CardSmall)
            .clickable(enabled = !locked, onClick = onClick)
            .semantics { contentDescription = spoken }
            .padding(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            AvatarArt(item.id, 52.dp)
            if (locked) {
                Box(
                    Modifier.size(52.dp).clip(GrowthShapes.Pill).background(Color(0x99FFFFFF)),
                    contentAlignment = Alignment.Center,
                ) { Text("🔒", fontSize = 18.sp) }
            }
        }
        Text(
            text,
            style = MaterialTheme.typography.labelSmall,   // 14sp
            color = textColor,
            fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
            maxLines = 2,
        )
    }
}

/**
 * 头像选择器：当前头像预览 + 4 列网格。
 * 文案全部为中性陈述（「升到下一档解锁」「继续学习会解锁更多头像」「可选」「已选用」），
 * 不含损失厌恶、催促、施压话术，不出现「已掌握 / 已达到 A1」类表述；
 * 状态同时由图标、文字与形状（描边 / 底色）表达。
 */
@Composable
fun AvatarPicker(
    current: String,
    dashboard: JSONObject?,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val child = LocalChildTheme.current
    val unlocked = AvatarUnlockPolicy.unlockedOf(dashboard)
    val isPreset = AvatarCatalog.isPreset(current)
    val ahead = AvatarUnlockPolicy.unlockAhead(dashboard)
    val allUnlocked = unlocked >= AvatarUnlockPolicy.TOTAL
    val baseReady = unlocked >= AvatarCatalog.BASIC_COUNT
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        // 当前头像预览
        Row(
            Modifier
                .fillMaxWidth()
                .clip(GrowthShapes.CardSmall)
                .background(GrowthColors.Cream)
                .padding(12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            AvatarArt(current, 64.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("当前头像", style = MaterialTheme.typography.titleMedium, color = GrowthColors.Ink)
                Text(
                    AvatarCatalog.labelOf(current),
                    style = MaterialTheme.typography.bodySmall,
                    color = GrowthColors.InkSoft,
                )
                GrowthPill(
                    if (isPreset) "✅ 已选用" else "🔗 自定义头像链接",
                    if (child) GrowthColors.MintDeep else GrowthColors.ForestDeep,
                    GrowthColors.MintWash,
                )
            }
        }

        // 中性说明：解锁数与档位措辞全部来自服务端，客户端不重算
        Text(
            "${AvatarUnlockPolicy.displayLabel(dashboard)} · 已解锁 $unlocked / ${AvatarCatalog.items.size} 个",
            style = MaterialTheme.typography.bodySmall,
            color = GrowthColors.InkSoft,
        )
        // 解锁预告：只按 unlockAhead 说明「下一次新增」发生在几档之后，不承诺相邻档必有新增
        Text(
            when {
                allUnlocked -> "34 个头像已全部解锁"
                ahead != null -> (if (baseReady) "24 个基础头像可随时更换；" else "") +
                    "再升 ${ahead.tiers} 档（档位 ${ahead.tier}）可解锁 ${ahead.additional} 个立体头像"
                else -> (if (baseReady) "24 个基础头像可随时更换；" else "") +
                    "继续学习会解锁更多立体头像"
            },
            style = MaterialTheme.typography.bodySmall,
            color = GrowthColors.InkSoft,
        )
        // 契约要求：展示档位时 CEFR_LEVEL_NOTICE 必须原样可见
        Text(
            AvatarUnlockPolicy.notice(dashboard),
            style = MaterialTheme.typography.bodySmall,
            color = GrowthColors.InkSoft,
        )
        if (!isPreset && current.isNotBlank()) {
            Text(
                "当前使用自定义头像链接，可从下方选一个本地头像。",
                style = MaterialTheme.typography.bodySmall,
                color = GrowthColors.InkSoft,
            )
        }
        Text(
            "选好后请点「保存资料」提交。",
            style = MaterialTheme.typography.bodySmall,
            color = GrowthColors.InkSoft,
        )

        // 4 列网格（非 Lazy，外层页面已有 verticalScroll，避免无限高容器冲突）
        AvatarCatalog.items.chunked(4).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { item ->
                    AvatarTile(
                        item = item,
                        locked = item.index >= unlocked,
                        selected = item.id == current,
                        onClick = { onSelect(item.id) },
                    )
                }
                repeat(4 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}
