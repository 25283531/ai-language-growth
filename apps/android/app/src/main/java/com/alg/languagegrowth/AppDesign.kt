package com.alg.languagegrowth

/*
 * ============================================================================
 * AI Language Growth · 儿童向设计系统（6–9 岁）  "温柔的彩虹教室"
 * ----------------------------------------------------------------------------
 * 美学关键词：柔和 Soft / 明快 Cheerful / 可信 Trustworthy
 * 产品人设映射：patient（不催促）· gentle（不刺眼）· encouraging（正向反馈）
 * 隐私边界：装饰图形不拟人化为家长 / 朋友，不出现亲昵称呼，不引导付费与广告。
 * 图形语言：Compose Canvas 自绘 + 系统 emoji，零外部图片、零网络依赖。
 *           底部导航为自绘矢量图标（房子/书本/奖章/人像）+ contentDescription，不用字形或 emoji 当图标。
 * 无障碍（产品评审硬指标）：正文 ≥16sp · 辅助标签 ≥14sp · 关键学习文本 ≥20sp · 触控 ≥48dp ·
 *   正文对比度 ≥4.5:1 / 大字与图形 ≥3:1 · 选中态「图标 + 文字 + 形状」三冗余（不只靠颜色）·
 *   成功 / 错误 / 信息三类状态均有图标 + 文字兜底且视觉可区分。
 *
 * 色彩（浅色主题，浅底深字，正文对背景 ≥ 4.5:1，按钮大字号 ≥ 3:1）
 *   Cream      #FFF8F0 背景   CreamDeep #FFF0E2 背景渐变下端   Surface #FFFFFF 卡片
 *   Ink        #2E3A45 主文本  InkSoft #566772 次文本          Outline #F0E1D2 描边
 *   Primary    #E8623C 主按钮底 PrimaryDeep #B8411F 主色文字    PrimaryWash #FFE9DF
 *   Blue       #3F82D6 / BlueDeep #2A5FA8 / BlueWash #E6F1FF
 *   Sun        #FFC24B / SunDeep #8A5A10  / SunWash  #FFF3D6
 *   Mint       #3FAE86 / MintDeep #20775A / MintWash #E1F5EC
 *   Grape      #8B6FD6 / GrapeDeep #6243A8/ GrapeWash #F0E9FF
 *   Forest     #176B5B 监护人主题主色 / ForestWash #E7F1EC
 *
 * 圆角：卡片 24dp · 小卡 20dp · 按钮 20dp · 输入框 18dp · 胶囊 50%
 * 阴影：柔和彩色投影 6–8dp（ambient/spot = PrimaryDeep @10–14%），配 1.5dp 暖色描边
 * 字号(sp/行高)：Display 30/40 · H1 24/32 · H2 20/28 · 关键学习文本 20/30 ·
 *                Body 16/24 · 辅助标签 14/20（全表最小 14sp）· 按钮 18/26
 * 触控：最小 48dp；主按钮 56dp；导航项 64dp；输入框 ≥56dp；次要按钮 ≥52dp
 * 间距：4dp 基准 → 8 / 12 / 16 / 20 / 24 / 32；屏幕留白 20，卡片内边距 20，卡片间距 16
 * 动效：仅 Material3 内置 ripple / 状态 / 进度动画 + 吉祥物呼吸浮动
 *       快速 150ms · 标准 250ms · 呼吸 3200ms；无旋转、无闪烁、尊重系统"减少动态效果"
 * ============================================================================
 */

import android.provider.Settings
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.matchParentSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Shapes
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Typography
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/* ------------------------------------------------------------------ Tokens */

object GrowthColors {
    val Cream = Color(0xFFFFF8F0)
    val CreamDeep = Color(0xFFFFF0E2)
    val Surface = Color(0xFFFFFFFF)
    val Ink = Color(0xFF2E3A45)
    val InkSoft = Color(0xFF566772)
    val Outline = Color(0xFFF0E1D2)

    val Primary = Color(0xFFE8623C)
    val PrimaryDeep = Color(0xFFB8411F)
    val PrimaryWash = Color(0xFFFFE9DF)

    val Blue = Color(0xFF3F82D6)
    val BlueDeep = Color(0xFF2A5FA8)
    val BlueWash = Color(0xFFE6F1FF)

    val Sun = Color(0xFFFFC24B)
    val SunDeep = Color(0xFF8A5A10)
    val SunWash = Color(0xFFFFF3D6)

    val Mint = Color(0xFF3FAE86)
    val MintDeep = Color(0xFF20775A)
    val MintWash = Color(0xFFE1F5EC)

    val Grape = Color(0xFF8B6FD6)
    val GrapeDeep = Color(0xFF6243A8)
    val GrapeWash = Color(0xFFF0E9FF)

    val Pink = Color(0xFFF07FA6)
    val Danger = Color(0xFFD24B40)
    val DangerWash = Color(0xFFFFE7E4)

    /** 监护人（成人）主题：收敛、高对比、少装饰，保证"我/设置"依然清晰可用。 */
    val Forest = Color(0xFF176B5B)
    val ForestDeep = Color(0xFF0F4C40)
    val ForestWash = Color(0xFFE7F1EC)
    val GuardianBg = Color(0xFFF4F7F4)
}

object GrowthShapes {
    val Card = RoundedCornerShape(24.dp)
    val CardSmall = RoundedCornerShape(20.dp)
    val Button = RoundedCornerShape(20.dp)
    val Field = RoundedCornerShape(18.dp)
    val Bubble = RoundedCornerShape(20.dp)
    val Pill = RoundedCornerShape(percent = 50)
}

object GrowthDimens {
    val ScreenPad: Dp = 20.dp
    val CardPad: Dp = 20.dp
    val CardPadSmall: Dp = 16.dp
    val ButtonHeight: Dp = 56.dp
    val MinTouch: Dp = 48.dp
    val NavHeight: Dp = 64.dp
    val CardGap: Dp = 16.dp
    val SectionGap: Dp = 24.dp
    val ItemGap: Dp = 12.dp
}

private fun ts(size: Int, line: Int, weight: FontWeight, tracking: Float = 0f) = TextStyle(
    fontFamily = FontFamily.Default,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = line.sp,
    letterSpacing = tracking.sp,
)

/**
 * 字号阶梯（产品评审无障碍硬指标）：
 * 正文 ≥16sp · 辅助标签 ≥14sp · 老师话术 / 示范文本等关键学习文本 ≥20sp。
 * 全表最小 14sp，不再出现 12/13sp 的 Muted 提示；辅助文字统一 InkSoft（对比度 ≥4.5:1）。
 */
val GrowthTypography = Typography(
    displaySmall = ts(30, 40, FontWeight.Bold),
    headlineLarge = ts(28, 38, FontWeight.Bold),
    headlineMedium = ts(24, 32, FontWeight.Bold),
    headlineSmall = ts(20, 28, FontWeight.Bold),
    titleLarge = ts(20, 30, FontWeight.Bold),      // 关键学习文本（老师话术 / 示范文本）
    titleMedium = ts(17, 26, FontWeight.SemiBold),
    titleSmall = ts(16, 24, FontWeight.SemiBold),
    bodyLarge = ts(16, 24, FontWeight.Normal),
    bodyMedium = ts(16, 24, FontWeight.Normal),
    bodySmall = ts(14, 20, FontWeight.Medium),
    labelLarge = ts(18, 26, FontWeight.Bold),
    labelMedium = ts(16, 22, FontWeight.Medium),
    labelSmall = ts(14, 20, FontWeight.Bold, 0.6f),
)

private val GrowthMaterialShapes = Shapes(
    small = GrowthShapes.CardSmall,
    medium = GrowthShapes.Field,
    large = GrowthShapes.Card,
    extraLarge = GrowthShapes.Card,
)

/* ------------------------------------------------------------------- Theme */

val LocalChildTheme = staticCompositionLocalOf { true }

@Composable
fun GrowthTheme(childTheme: Boolean, content: @Composable () -> Unit) {
    // styles.xml 提供首帧默认系统栏色；这里在主题切换时同步，保持两个主题都为浅色底 + 深色图标。
    val activity = LocalContext.current as? android.app.Activity
    SideEffect {
        activity?.window?.let { window ->
            val barColor = android.graphics.Color.parseColor(if (childTheme) "#FFF8F0" else "#F4F7F4")
            window.statusBarColor = barColor
            window.navigationBarColor = barColor
        }
    }
    val scheme = if (childTheme) lightColorScheme(
        primary = GrowthColors.Primary,
        onPrimary = Color.White,
        primaryContainer = GrowthColors.PrimaryWash,
        onPrimaryContainer = GrowthColors.PrimaryDeep,
        secondary = GrowthColors.Blue,
        onSecondary = Color.White,
        secondaryContainer = GrowthColors.BlueWash,
        onSecondaryContainer = GrowthColors.BlueDeep,
        tertiary = GrowthColors.Mint,
        background = GrowthColors.Cream,
        onBackground = GrowthColors.Ink,
        surface = GrowthColors.Surface,
        onSurface = GrowthColors.Ink,
        surfaceVariant = GrowthColors.CreamDeep,
        onSurfaceVariant = GrowthColors.InkSoft,
        outline = GrowthColors.Outline,
        error = GrowthColors.Danger,
        onError = Color.White,
    ) else lightColorScheme(
        primary = GrowthColors.Forest,
        onPrimary = Color.White,
        primaryContainer = GrowthColors.ForestWash,
        onPrimaryContainer = GrowthColors.ForestDeep,
        secondary = Color(0xFF557A73),
        onSecondary = Color.White,
        background = GrowthColors.GuardianBg,
        onBackground = Color(0xFF202B28),
        surface = GrowthColors.Surface,
        onSurface = Color(0xFF202B28),
        surfaceVariant = GrowthColors.ForestWash,
        onSurfaceVariant = GrowthColors.InkSoft,
        outline = GrowthColors.ForestWash,
        error = GrowthColors.Danger,
        onError = Color.White,
    )
    MaterialTheme(colorScheme = scheme, typography = GrowthTypography, shapes = GrowthMaterialShapes) {
        CompositionLocalProvider(
            LocalChildTheme provides childTheme,
            LocalContentColor provides GrowthColors.Ink,
        ) {
            content()
        }
    }
}

/** 监护人主题下把彩色底收敛为统一的浅绿/白，保证家长向页面清晰、不花哨。 */
@Composable
private fun themedWash(wash: Color): Color =
    if (LocalChildTheme.current) wash else GrowthColors.ForestWash

@Composable
private fun themedTint(tint: Color): Color =
    if (LocalChildTheme.current) tint else GrowthColors.ForestDeep

/* --------------------------------------------------------------- Background */

@Composable
fun GrowthBackground(content: @Composable BoxScope.() -> Unit) {
    val child = LocalChildTheme.current
    val top = if (child) GrowthColors.Cream else GrowthColors.GuardianBg
    val bottom = if (child) GrowthColors.CreamDeep else Color(0xFFE9F1EB)
    Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(top, bottom)))) {
        if (child) DecorCanvas()
        content()
    }
}

@Composable
private fun BoxScope.DecorCanvas() {
    Canvas(Modifier.matchParentSize()) {
        val w = size.width
        val h = size.height
        // 柔和大色块（低透明度，不干扰可读性）
        drawCircle(GrowthColors.SunWash.copy(alpha = 0.55f), radius = w * 0.34f, center = Offset(w * 1.03f, h * 0.05f))
        drawCircle(GrowthColors.BlueWash.copy(alpha = 0.55f), radius = w * 0.28f, center = Offset(-w * 0.10f, h * 0.30f))
        drawCircle(GrowthColors.MintWash.copy(alpha = 0.45f), radius = w * 0.24f, center = Offset(w * 0.95f, h * 0.78f))
        // 左上角淡彩虹弧
        val rainbow = listOf(GrowthColors.Primary, GrowthColors.Sun, GrowthColors.Mint, GrowthColors.Blue)
        rainbow.forEachIndexed { i, c ->
            val inset = w * 0.05f + i * 10f
            drawArc(
                color = c.copy(alpha = 0.18f),
                startAngle = 90f,
                sweepAngle = 120f,
                useCenter = false,
                topLeft = Offset(inset, h * 0.012f + i * 10f),
                size = Size(w * 0.44f, w * 0.44f),
                style = Stroke(width = 8f),
            )
        }
        // 零散小圆点
        val dots = listOf(
            Offset(w * 0.86f, h * 0.32f) to GrowthColors.Grape,
            Offset(w * 0.12f, h * 0.62f) to GrowthColors.Mint,
            Offset(w * 0.78f, h * 0.60f) to GrowthColors.Sun,
            Offset(w * 0.30f, h * 0.88f) to GrowthColors.Blue,
        )
        dots.forEach { (p, c) -> drawCircle(c.copy(alpha = 0.22f), radius = 5f, center = p) }
    }
}

/* ------------------------------------------------------------------ Mascot */

@Composable
private fun rememberReduceMotion(): Boolean {
    val context = LocalContext.current
    return remember {
        runCatching {
            Settings.Global.getFloat(
                context.contentResolver,
                Settings.Global.ANIMATOR_DURATION_SCALE,
                1f,
            ) == 0f
        }.getOrDefault(false)
    }
}

/**
 * 课堂伙伴"小芽 Buddy"：纯 Canvas 自绘的圆脸 + 两片叶子 + 微笑。
 * 仅作装饰，不说话、不称呼孩子，避免被理解为家长 / 朋友（隐私边界）。
 * 动效：周期约 3.3s、幅度 4dp 的呼吸浮动；系统关闭动画时自动静止。
 */
@Composable
fun BuddyMascot(modifier: Modifier = Modifier, size: Dp = 96.dp) {
    val reduce = rememberReduceMotion()
    var phase by remember { mutableStateOf(0f) }
    LaunchedEffect(reduce) {
        if (reduce) {
            phase = 0f
            return@LaunchedEffect
        }
        while (true) {
            delay(40)
            phase += 0.076f // 约 3.3s 一个周期
        }
    }
    val bob = if (reduce) 0f else sin(phase) * 4f
    Canvas(modifier.size(size).offset(y = bob.dp)) {
        drawBuddy()
    }
}

private fun DrawScope.drawBuddy() {
    val s = size.minDimension
    val cx = size.width / 2f
    val cy = size.height * 0.56f   // 略微下移，给顶部两片叶子留出完整绘制空间
    val r = s * 0.30f

    // 地面淡影
    drawOval(
        color = GrowthColors.Ink.copy(alpha = 0.08f),
        topLeft = Offset(cx - r * 0.9f, cy + r * 0.92f),
        size = Size(r * 1.8f, r * 0.26f),
    )

    // 左叶（控制点全部落在画布内，叶片完整可见）
    val leafLeft = Path().apply {
        moveTo(cx - r * 0.05f, cy - r * 0.75f)
        quadraticBezierTo(cx - r * 1.00f, cy - r * 1.70f, cx - r * 0.05f, cy - r * 1.45f)
        quadraticBezierTo(cx - r * 0.38f, cy - r * 1.05f, cx - r * 0.05f, cy - r * 0.75f)
        close()
    }
    drawPath(leafLeft, GrowthColors.Mint)
    // 右叶
    val leafRight = Path().apply {
        moveTo(cx + r * 0.05f, cy - r * 0.75f)
        quadraticBezierTo(cx + r * 1.00f, cy - r * 1.70f, cx + r * 0.05f, cy - r * 1.45f)
        quadraticBezierTo(cx + r * 0.38f, cy - r * 1.05f, cx + r * 0.05f, cy - r * 0.75f)
        close()
    }
    drawPath(leafRight, GrowthColors.MintDeep)

    // 圆脸
    drawCircle(GrowthColors.MintWash, radius = r, center = Offset(cx, cy))
    drawCircle(GrowthColors.Surface.copy(alpha = 0.55f), radius = r * 0.74f, center = Offset(cx, cy - r * 0.08f))
    drawCircle(
        color = GrowthColors.MintDeep.copy(alpha = 0.22f),
        radius = r,
        center = Offset(cx, cy),
        style = Stroke(width = s * 0.018f),
    )

    // 眼睛 + 高光
    val eyeY = cy - r * 0.06f
    val eyeDx = r * 0.35f
    drawCircle(GrowthColors.Ink, radius = s * 0.032f, center = Offset(cx - eyeDx, eyeY))
    drawCircle(GrowthColors.Ink, radius = s * 0.032f, center = Offset(cx + eyeDx, eyeY))
    drawCircle(Color.White, radius = s * 0.011f, center = Offset(cx - eyeDx + s * 0.01f, eyeY - s * 0.012f))
    drawCircle(Color.White, radius = s * 0.011f, center = Offset(cx + eyeDx + s * 0.01f, eyeY - s * 0.012f))

    // 腮红
    drawCircle(GrowthColors.Pink.copy(alpha = 0.5f), radius = s * 0.042f, center = Offset(cx - r * 0.62f, cy + r * 0.24f))
    drawCircle(GrowthColors.Pink.copy(alpha = 0.5f), radius = s * 0.042f, center = Offset(cx + r * 0.62f, cy + r * 0.24f))

    // 微笑
    val mw = r * 0.62f
    drawArc(
        color = GrowthColors.Ink,
        startAngle = 0f,
        sweepAngle = 180f,
        useCenter = false,
        topLeft = Offset(cx - mw / 2f, cy + r * 0.10f),
        size = Size(mw, r * 0.44f),
        style = Stroke(width = s * 0.018f, cap = StrokeCap.Round),
    )
}

/* --------------------------------------------------------------- Primitives */

@Composable
fun GrowthCard(
    modifier: Modifier = Modifier,
    fill: Color = GrowthColors.Surface,
    outline: Color = GrowthColors.Outline,
    contentPadding: Dp = GrowthDimens.CardPad,
    content: @Composable ColumnScope.() -> Unit,
) {
    val child = LocalChildTheme.current
    val background = if (child) fill else GrowthColors.Surface
    val stroke = if (child) outline else GrowthColors.ForestWash
    Box(
        modifier
            .shadow(
                if (child) 8.dp else 2.dp,
                GrowthShapes.Card,
                ambientColor = GrowthColors.PrimaryDeep.copy(alpha = if (child) 0.10f else 0.05f),
                spotColor = GrowthColors.PrimaryDeep.copy(alpha = if (child) 0.14f else 0.06f),
            )
            .background(background, GrowthShapes.Card)
            .border(1.5.dp, stroke, GrowthShapes.Card)
            .padding(contentPadding),
    ) {
        Column(
            Modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(GrowthDimens.ItemGap),
        ) { content() }
    }
}

@Composable
fun GrowthPageHeader(title: String, subtitle: String, emoji: String) {
    val child = LocalChildTheme.current
    val badge = themedWash(GrowthColors.PrimaryWash)
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(
            Modifier
                .size(54.dp)
                .clip(GrowthShapes.CardSmall)
                .background(badge)
                .border(1.5.dp, GrowthColors.Primary.copy(alpha = 0.18f), GrowthShapes.CardSmall),
            contentAlignment = Alignment.Center,
        ) { Text(emoji, fontSize = 26.sp) }
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = if (child) MaterialTheme.typography.displaySmall else MaterialTheme.typography.headlineMedium,
                color = GrowthColors.Ink,
            )
            if (subtitle.isNotBlank()) {
                Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = GrowthColors.InkSoft)
            }
        }
    }
}

@Composable
fun GrowthSectionTitle(text: String, emoji: String = "", tint: Color = GrowthColors.Ink) {
    Row(
        Modifier.padding(top = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (emoji.isNotBlank()) Text(emoji, fontSize = 20.sp)
        Text(text, style = MaterialTheme.typography.headlineSmall, color = tint)
    }
}

@Composable
fun GrowthPill(
    text: String,
    tint: Color,
    wash: Color,
    modifier: Modifier = Modifier,
    emoji: String = "",
) {
    val fg = themedTint(tint)
    val bg = themedWash(wash)
    Row(
        modifier
            .clip(GrowthShapes.Pill)
            .background(bg)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (emoji.isNotBlank()) Text(emoji, fontSize = 14.sp)
        Text(text, style = MaterialTheme.typography.labelSmall, color = fg)
    }
}

/**
 * 状态提示：错误 / 成功 / 信息三类可区分，且都有「图标 + 文字」兜底，不只靠颜色。
 * tone 可显式指定；不指定时按文案做纯视觉推断，不改动任何业务状态与 API 文案。
 */
enum class GrowthStatusTone { Info, Success, Error }

private data class StatusPalette(
    val icon: String,
    val foreground: Color,
    val background: Color,
    val border: Color,
)

private fun statusPalette(tone: GrowthStatusTone): StatusPalette = when (tone) {
    GrowthStatusTone.Success -> StatusPalette("✅", GrowthColors.MintDeep, GrowthColors.MintWash, GrowthColors.Mint)
    GrowthStatusTone.Error -> StatusPalette("⚠️", GrowthColors.Danger, GrowthColors.DangerWash, GrowthColors.Danger)
    GrowthStatusTone.Info -> StatusPalette("ℹ️", GrowthColors.BlueDeep, GrowthColors.BlueWash, GrowthColors.Blue)
}

private fun toneOf(text: String): GrowthStatusTone = when {
    text.contains("失败") || text.contains("无法") || text.contains("错误") ||
        text.contains("请先") || text.contains("必须") || text.contains("暂时") ||
        text.contains("尚未") || text.contains("不可") -> GrowthStatusTone.Error
    text.contains("成功") || text.contains("已保存") || text.contains("已更新") ||
        text.contains("完成") || text.contains("已注销") || text.contains("已修改") ||
        text.contains("欢迎加入") -> GrowthStatusTone.Success
    else -> GrowthStatusTone.Info
}

@Composable
fun GrowthStatusPill(
    text: String,
    modifier: Modifier = Modifier,
    tone: GrowthStatusTone? = null,
) {
    if (text.isBlank()) return
    // 语义色在儿童 / 成人双主题下保持一致，避免错误态与成功态在监护人主题里重新同色。
    val palette = statusPalette(tone ?: toneOf(text))
    Row(
        modifier
            .fillMaxWidth()
            .clip(GrowthShapes.Pill)
            .background(palette.background)
            .border(1.5.dp, palette.border.copy(alpha = 0.30f), GrowthShapes.Pill)
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(palette.icon, fontSize = 18.sp)
        Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, color = palette.foreground)
    }
}

@Composable
fun GrowthPrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    emoji: String = "",
    enabled: Boolean = true,
    busy: Boolean = false,
    container: Color = GrowthColors.Primary,
) {
    val base = if (LocalChildTheme.current) container else GrowthColors.Forest
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        modifier = modifier
            .fillMaxWidth()
            .height(GrowthDimens.ButtonHeight)
            .shadow(
                6.dp,
                GrowthShapes.Button,
                ambientColor = base.copy(alpha = 0.24f),
                spotColor = base.copy(alpha = 0.30f),
            ),
        shape = GrowthShapes.Button,
        colors = ButtonDefaults.buttonColors(
            containerColor = base,
            contentColor = Color.White,
            disabledContainerColor = base.copy(alpha = 0.45f),
            disabledContentColor = Color.White.copy(alpha = 0.9f),
        ),
        elevation = ButtonDefaults.buttonElevation(defaultElevation = 0.dp, pressedElevation = 0.dp),
    ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(22.dp), color = Color.White, strokeWidth = 2.5.dp)
        } else {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (emoji.isNotBlank()) Text(emoji, fontSize = 20.sp)
                Text(text, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

@Composable
fun GrowthSecondaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    emoji: String = "",
    enabled: Boolean = true,
) {
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().heightIn(min = 52.dp),
        shape = GrowthShapes.Button,
        border = BorderStroke(1.5.dp, GrowthColors.Outline),
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = GrowthColors.Surface,
            contentColor = GrowthColors.Ink,
        ),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (emoji.isNotBlank()) Text(emoji, fontSize = 18.sp)
            Text(text, style = MaterialTheme.typography.titleMedium)
        }
    }
}

@Composable
fun GrowthTextButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    emoji: String = "",
    tint: Color = GrowthColors.PrimaryDeep,
) {
    TextButton(
        onClick = onClick,
        modifier = modifier.heightIn(min = GrowthDimens.MinTouch),
        shape = GrowthShapes.Pill,
        colors = ButtonDefaults.textButtonColors(contentColor = themedTint(tint)),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (emoji.isNotBlank()) Text(emoji, fontSize = 16.sp)
            Text(text, style = MaterialTheme.typography.titleMedium)
        }
    }
}

@Composable
fun GrowthTextField(
    value: String,
    onValue: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier.fillMaxWidth(),
    placeholder: String = "",
    password: Boolean = false,
    leadingEmoji: String = "",
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValue,
        modifier = modifier.heightIn(min = 56.dp),
        label = { Text(label, style = MaterialTheme.typography.bodyMedium) },
        placeholder = {
            if (placeholder.isNotBlank()) Text(placeholder, style = MaterialTheme.typography.bodyMedium)
        },
        leadingIcon = { if (leadingEmoji.isNotBlank()) Text(leadingEmoji, fontSize = 20.sp) },
        singleLine = true,
        shape = GrowthShapes.Field,
        textStyle = MaterialTheme.typography.bodyLarge,
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = GrowthColors.Primary,
            unfocusedBorderColor = GrowthColors.Outline,
            focusedLabelColor = GrowthColors.PrimaryDeep,
            unfocusedLabelColor = GrowthColors.InkSoft,
            cursorColor = GrowthColors.Primary,
        ),
    )
}

@Composable
fun GrowthSelect(
    text: String,
    emoji: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 54.dp)
            .clip(GrowthShapes.Field)
            .background(GrowthColors.Surface)
            .border(1.5.dp, GrowthColors.Outline, GrowthShapes.Field)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(emoji, fontSize = 20.sp)
        Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge, color = GrowthColors.Ink)
        Text("▾", fontSize = 18.sp, color = GrowthColors.InkSoft)
    }
}

@Composable
fun GrowthLinkRow(
    text: String,
    emoji: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    danger: Boolean = false,
) {
    val fg = if (danger) GrowthColors.Danger else GrowthColors.Ink
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp)
            .clip(GrowthShapes.CardSmall)
            .background(if (danger) GrowthColors.DangerWash else GrowthColors.Cream)
            .border(
                1.5.dp,
                if (danger) GrowthColors.Danger.copy(alpha = 0.22f) else GrowthColors.Outline,
                GrowthShapes.CardSmall,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(emoji, fontSize = 20.sp)
        Text(text, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, color = fg)
        Text("›", fontSize = 22.sp, color = GrowthColors.InkSoft)
    }
}

/* ------------------------------------------------------------ Data display */

@Composable
fun GrowthStatTile(
    value: String,
    label: String,
    emoji: String,
    tint: Color,
    wash: Color,
    modifier: Modifier = Modifier,
) {
    val child = LocalChildTheme.current
    val fg = themedTint(tint)
    val bg = themedWash(wash)
    Column(
        modifier
            .shadow(
                if (child) 6.dp else 2.dp,
                GrowthShapes.CardSmall,
                ambientColor = GrowthColors.PrimaryDeep.copy(alpha = 0.08f),
                spotColor = GrowthColors.PrimaryDeep.copy(alpha = 0.10f),
            )
            .clip(GrowthShapes.CardSmall)
            .background(bg)
            .border(1.5.dp, fg.copy(alpha = 0.18f), GrowthShapes.CardSmall)
            .padding(GrowthDimens.CardPadSmall),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(emoji, fontSize = 24.sp)
        Text(value, style = MaterialTheme.typography.headlineMedium, color = fg)
        Text(label, style = MaterialTheme.typography.bodySmall, color = GrowthColors.InkSoft)
    }
}

/** 5 段式（实际 4 段，stage 0..4）胶囊进度，替代 8dp 细进度条，数据含义不变。 */
@Composable
fun SegmentedProgress(stage: Int, tint: Color, modifier: Modifier = Modifier) {
    val filled = stage.coerceIn(0, 4)
    val color = themedTint(tint)
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        repeat(4) { index ->
            Box(
                Modifier
                    .weight(1f)
                    .height(10.dp)
                    .clip(GrowthShapes.Pill)
                    .background(if (index < filled) color else color.copy(alpha = 0.16f)),
            )
        }
    }
}

@Composable
fun GrowthSpeechBubble(
    text: String,
    tint: Color,
    wash: Color,
    emoji: String,
    modifier: Modifier = Modifier,
    big: Boolean = false,
) {
    val fg = themedTint(tint)
    val bg = themedWash(wash)
    Box(
        modifier
            .fillMaxWidth()
            .clip(GrowthShapes.Bubble)
            .background(bg)
            .border(1.5.dp, fg.copy(alpha = 0.20f), GrowthShapes.Bubble)
            .padding(GrowthDimens.CardPadSmall),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(emoji, fontSize = if (big) 24.sp else 22.sp)
            Text(
                text,
                Modifier.weight(1f),
                // 老师话术 / 示范文本属于关键学习文本，硬指标 ≥20sp（titleLarge = 20sp / 30sp）
                style = MaterialTheme.typography.titleLarge,
                lineHeight = 30.sp,
                color = GrowthColors.Ink,
            )
        }
    }
}

private fun starPath(center: Offset, outer: Float, inner: Float): Path {
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

/** 自绘圆形勋章：已获得为亮色奖章，未获得为柔和灰 + 细环，像收集册而非设置列表。 */
@Composable
fun MedalBadge(earned: Boolean, modifier: Modifier = Modifier, size: Dp = 56.dp) {
    Canvas(modifier.size(size)) {
        val r = size.minDimension / 2f
        val c = Offset(size.width / 2f, size.height / 2f)
        val ring = if (earned) GrowthColors.Sun else Color(0xFFD9DEE2)
        val fill = if (earned) GrowthColors.SunWash else Color(0xFFF4F5F6)
        drawCircle(fill, radius = r * 0.92f, center = c)
        drawCircle(ring, radius = r * 0.92f, center = c, style = Stroke(width = r * 0.14f))
        drawPath(
            starPath(c, r * 0.56f, r * 0.25f),
            if (earned) GrowthColors.SunDeep else Color(0xFFB7C0C6),
        )
    }
}

/* ------------------------------------------------------------- Navigation */

data class GrowthNavItemData(
    val key: String,
    val label: String,
    val icon: String,   // 自绘矢量图标种类，不用文本字形 / emoji 当图标，避免 TalkBack 读成乱码
    val tint: Color,
    val wash: Color,
)

val GrowthNavItems = listOf(
    GrowthNavItemData("home", "首页", "home", GrowthColors.PrimaryDeep, GrowthColors.PrimaryWash),
    GrowthNavItemData("learn", "学习", "learn", GrowthColors.BlueDeep, GrowthColors.BlueWash),
    GrowthNavItemData("achievements", "成就", "achievements", GrowthColors.SunDeep, GrowthColors.SunWash),
    GrowthNavItemData("me", "我", "me", GrowthColors.MintDeep, GrowthColors.MintWash),
)

/**
 * 底部导航自绘矢量图标（房子 / 书本 / 奖章星 / 人像），纯 Canvas，无资源依赖。
 * 选中 = 实心填充，未选中 = 描边；配合彩色胶囊 + 加粗文字形成「图标 + 文字 + 形状」三冗余，
 * 不依赖颜色单通道传达状态。
 */
@Composable
private fun NavVectorIcon(kind: String, active: Boolean, color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(26.dp)) {
        val s = size.minDimension
        val style = if (active) Fill else Stroke(width = s * 0.085f, cap = StrokeCap.Round)
        when (kind) {
            "home" -> {
                val roof = Path().apply {
                    moveTo(s * 0.50f, s * 0.10f)
                    lineTo(s * 0.93f, s * 0.47f)
                    lineTo(s * 0.07f, s * 0.47f)
                    close()
                }
                drawPath(roof, color, style = style)
                drawRect(color, topLeft = Offset(s * 0.19f, s * 0.46f), size = Size(s * 0.62f, s * 0.42f), style = style)
            }
            "learn" -> {
                drawRoundRect(
                    color, topLeft = Offset(s * 0.10f, s * 0.18f), size = Size(s * 0.36f, s * 0.64f),
                    cornerRadius = CornerRadius(s * 0.05f), style = style,
                )
                drawRoundRect(
                    color, topLeft = Offset(s * 0.54f, s * 0.18f), size = Size(s * 0.36f, s * 0.64f),
                    cornerRadius = CornerRadius(s * 0.05f), style = style,
                )
            }
            "achievements" -> {
                drawCircle(color, radius = s * 0.37f, center = Offset(s * 0.5f, s * 0.5f), style = style)
                drawPath(starPath(Offset(s * 0.5f, s * 0.5f), s * 0.22f, s * 0.10f), color, style = style)
            }
            else -> {
                drawCircle(color, radius = s * 0.15f, center = Offset(s * 0.5f, s * 0.30f), style = style)
                drawArc(
                    color, startAngle = 180f, sweepAngle = 180f, useCenter = false,
                    topLeft = Offset(s * 0.17f, s * 0.52f), size = Size(s * 0.66f, s * 0.48f), style = style,
                )
            }
        }
    }
}

@Composable
fun GrowthNavBar(selected: String, onSelect: (String) -> Unit) {
    NavigationBar(
        containerColor = GrowthColors.Surface,
        tonalElevation = 0.dp,
        modifier = Modifier.shadow(
            10.dp,
            RoundedCornerShape(0.dp),
            ambientColor = GrowthColors.Ink.copy(alpha = 0.06f),
            spotColor = GrowthColors.Ink.copy(alpha = 0.08f),
        ),
    ) {
        GrowthNavItems.forEach { item ->
            GrowthNavItem(
                item = item,
                selected = selected == item.key,
                onClick = { onSelect(item.key) },
            )
        }
    }
}

@Composable
private fun RowScope.GrowthNavItem(item: GrowthNavItemData, selected: Boolean, onClick: () -> Unit) {
    val child = LocalChildTheme.current
    val activeTint = if (child) item.tint else GrowthColors.ForestDeep
    val activeWash = if (child) item.wash else GrowthColors.ForestWash
    // 形状冗余：选中态除彩色胶囊外再加 2dp 描边，不只靠颜色区分
    val shapeCue = if (selected) Modifier.border(2.dp, activeTint.copy(alpha = 0.35f), GrowthShapes.Button) else Modifier
    val spokenLabel = "${item.label}，${if (selected) "已选中" else "未选中"}，共 ${GrowthNavItems.size} 个标签页"
    Box(
        Modifier
            .weight(1f)
            .height(GrowthDimens.NavHeight)   // 显式 64dp，≥48dp 触控目标
            .padding(horizontal = 6.dp, vertical = 6.dp)
            .clip(GrowthShapes.Button)
            .background(if (selected) activeWash else Color.Transparent)
            .then(shapeCue)
            .clickable(onClick = onClick)
            .semantics { contentDescription = spokenLabel },
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            NavVectorIcon(item.icon, selected, if (selected) activeTint else GrowthColors.InkSoft)
            Text(
                item.label,
                style = MaterialTheme.typography.labelSmall,   // 14sp
                color = if (selected) activeTint else GrowthColors.InkSoft,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
            )
        }
    }
}
