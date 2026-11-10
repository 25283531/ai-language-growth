# Android 正式客户端（M3）

当前首个开发切片包含 Jetpack Compose 课堂首页：配置学习者编号和 HTTPS 后端地址，调用 `POST /api/v1/lessons/start`，并展示服务端返回的主题、教师指令、示范文本和本轮目标。客户端不选择课程内容或修改学习状态。

## 安全边界

- 只允许 HTTPS 后端地址；Android 明文流量已关闭。
- 当前远程联调服务 `http://152.136.230.132:3100` 不可直接用于本客户端。正式真机联调前需要为服务配置 HTTPS 入口。
- 当前切片仅覆盖开课与指令展示。录音、ASR、TTS、语音额度租约、监护人账户和家长中心会按 M3 后续节点逐步接入；在此之前仍使用 `apps/android-audio-prototype` 验证现有音频额度链路。

## 云端构建

`.github/workflows/android-client.yml` 在变更或手动触发时编译 APK 并上传 artifact。手动运行时默认版本为 `0.0.1`（version code `1`），可选择 `debug` 或 `release`。

正式发布包需要在 GitHub 仓库 Secrets 配置 `KEYSTORE_BASE64`、`KEYSTORE_PASSWORD`、`KEY_ALIAS`、`KEY_PASSWORD`。工作流也兼容旧的 `ANDROID_*` 命名。工作流只在运行器临时目录解码签名文件，不把 keystore、密码或密钥写入仓库。
M1 runs a parallel minimal Android audio prototype (record / play / slow-speed / upload) to surface browser-vs-Android differences early: permissions, interruption, background playback, Bluetooth, player behaviour.

The Android client talks to the same backend and the same `/lessons/{id}/turn` orchestrator as the web client.

---

## 客户端界面（视觉层）

本轮为**视觉层改版**：只重构 Jetpack Compose 的 UI 呈现，网络请求、API 契约、数据模型、教学逻辑与业务状态机保持原样。设计令牌集中定义在 `app/src/main/java/com/alg/languagegrowth/AppDesign.kt`（与 `MainActivity.kt` 同包），`MainActivity.kt` 只保留业务与页面组装；未新增第三方依赖，未改动 `app/build.gradle.kts` 与 `AndroidManifest.xml`。

> **改动需重新构建 APK 才生效。** 源码变更不会自动进入已安装的 APK；请通过 `.github/workflows/android-client.yml` 重新构建，或在具备 JDK 17 / Android SDK / Gradle 8.7 的环境执行 `gradle --no-daemon assembleDebug` 后重新安装。当前开发机没有 JDK、Android SDK 与 Gradle，本轮改动未经本地编译器验证。

一份不依赖 APK 的静态视觉预览稿位于仓库外的交付目录 `G:/workbuddy/英语/deliverables/gstack/android-child-ui-preview.html`，纯 HTML + 内联 CSS，可在浏览器直接打开（示意数据，不可交互）。

### 双主题

| 项目 | 儿童主题（默认） | 成人 / 监护人主题 |
| --- | --- | --- |
| 作用域 | 全应用 7 个屏 | 全应用 7 个屏 |
| 配色 | 暖奶油渐变背景 + 多色柔和贴纸卡 + 自绘装饰 | 彩色收敛为白卡 + 浅绿描边，主按钮与主色统一为 `#176B5B` |
| 插画 | 显示「小芽 Buddy」吉祥物、彩虹弧、彩色气泡 | 隐藏装饰与吉祥物 |
| 系统栏 | `#FFF8F0` | `#F4F7F4` |

- **切换位置**：「我的账户」页（ProfileScreen）→「切换儿童主题 / 切换成人主题」。
- **持久化**：`SharedPreferences` 文件 `appearance`，布尔键 `childTheme`；默认 `true`。
- 语义色（成功 / 错误 / 信息）在两个主题下保持一致，避免状态在监护人主题里重新变成同色。
- 儿童 / 成人主题是**配色与装饰的切换**，不是明暗模式，也不是权限或内容分区。

### 设计令牌要点

- 色板：背景 `#FFF8F0 → #FFF0E2`，卡片 `#FFFFFF`，描边 `#F0E1D2`；主文本 `#2E3A45`、次文本 `#566772`；主色 `#E8623C`（白底上的主色文字用 `#B8411F`）；辅色 `#3F82D6`、强调 `#FFC24B`、薄荷 `#3FAE86`、紫 `#8B6FD6`、危险 `#D24B40`、监护人主题 `#176B5B`。原先游离于 MaterialTheme 之外的硬编码色（`Forest / ChildCoral / ChildBlue / Muted`）已收进主题令牌。
- 圆角：卡片 24dp、小卡 20dp、按钮 20dp、输入框 18dp、胶囊 50%；1.5dp 暖色描边 + 6–8dp 柔和彩色投影，替代 Material3 默认灰影与 8dp 小圆角。
- 字号：页面标题 30sp / 40sp、区块 20sp / 28sp、关键学习文本 20sp / 30sp、正文 16sp / 24sp、辅助标签 14sp / 20sp（全表最小 14sp）、按钮 18sp / 26sp。
- 触控与间距：最小触控 48dp（主按钮 56dp、导航项 64dp、输入框 ≥56dp、次要按钮 52dp）；4dp 基准（8 / 12 / 16 / 20 / 24 / 32），屏幕留白 20dp、卡片内边距 20dp、卡片间距 16dp。
- 图形：Compose Canvas 自绘「小芽 Buddy」、彩虹弧、星形勋章、4 段胶囊进度；底部导航为自绘矢量图标；卡片装饰使用系统 emoji。未新增外部图片、网络字体或第三方依赖。
- 动效：仅 Material3 内置 ripple / 状态动画 + 吉祥物呼吸浮动（约 3.3s、4dp），尊重系统「减少动态效果」设置。

### 屏与导航

- 7 个屏：登录 / 注册、首页、今天学什么、成长成就、我的账户、隐私协议、用户协议。
- 底部 4 个 tab：首页 / 学习 / 成就 / 我（自绘矢量图标：房子 / 书本 / 奖章 / 人像）。
- 系统栏颜色随主题同步；启动图标 `res/drawable/ic_launcher.xml` 与吉祥物图形语言统一。

### 无障碍硬指标

- 正文 ≥16sp、辅助标签 ≥14sp、老师话术与示范文本等关键学习文本 ≥20sp；原 12 / 13sp 的浅灰提示全部移除。
- 所有按钮与底部导航项显式 ≥48dp；注销确认弹窗按钮同样显式 48dp。
- 正文对比度 ≥4.5:1，大字 / 图形 ≥3:1；辅助文字使用 `#566772` 而非浅灰。
- 底部导航使用自绘矢量图标（不使用 `⌂ ▶ ★ ●` 文本字形或 emoji 当图标），每项带 `contentDescription`；选中态为「图标 + 文字 + 形状（彩色胶囊 + 2dp 描边）」三冗余，不只靠颜色。
- 成功 / 错误 / 信息提示，以及邮箱验证状态、勋章「已获得 / 继续加油」，均有图标 + 文字兜底，不只靠颜色。
- 已知缺口：卡片与按钮装饰仍使用系统 emoji，TalkBack 朗读效果与整体读屏顺序**待真机验证**；底部导航语义标签的实机朗读效果同样**待真机 TalkBack 验证**。

### 隐私红线（界面层）

- 不诱导儿童填写私人信息；不出现亲昵称呼；AI 老师不拟人化为家长或朋友。
- 不设面向儿童的广告、付费、会员、推送或打卡施压入口。
- 「小芽 Buddy」是纯装饰图形，不发起对话、不作称呼。
- 隐私协议与用户协议正文逐字未改，仅调整排版；页面标注由监护人陪同阅读。
- 本轮不新增任何数据采集、网络图片或第三方 SDK。

### 已知缺口 / 后续独立议题（本轮未实现）

- **儿童学习面 vs 监护人设置面分区 + 成人门禁**：产品评审中的相关建议（含 F3 / F10）本轮**未实现**；当前仅提供全局配色主题切换，不做页面分区重组、不新增家长中心、不增加任何门禁交互。该议题作为后续独立议题登记。
- 深色模式未实现；双主题为配色切换，非明暗模式。
- 开发机无 JDK / Android SDK / Gradle，本轮改动未经本地编译器验证；编译验证由云端工作流完成。
- 新增界面鼓励文案如纳入产品文案审核流程，需另行过审。

---

## 本地头像库与等级解锁

### 素材来源与许可证

基础头像共 **24 个**，全部为本地资源 `app/src/main/res/drawable/avatar_basic_01.xml` … `avatar_basic_24.xml`（Android VectorDrawable），运行时**不发起任何网络图片请求**。素材通过 DiceBear 9.x 官方 HTTP API 取得 SVG 后离线转换为 VectorDrawable，并按项目设计令牌加入柔和背景色。

- 风格：**Open Peeps**（DiceBear `open-peeps`），原作 **Pablo Stanley**，来源 <https://www.openpeeps.com/>
- 许可证：**CC0 1.0**（Public Domain Dedication，<https://creativecommons.org/publicdomain/zero/1.0/>），DiceBear 官方许可证页 <https://www.dicebear.com/licenses/> 将 Open Peeps 归入 CC0 1.0 组；每个原始 SVG 内嵌 RDF 元数据亦明确标注该许可
- 署名要求：**无需署名**（CC0 为权利放弃，可复制、修改、商用）；下表仍逐项列出来源以便审计
- DiceBear 代码本身为 MIT，但本客户端**不打包 DiceBear 代码、不引入其依赖**，只使用生成的矢量图形
- 生成接口：`https://api.dicebear.com/9.x/open-peeps/svg?seed=<seed>`；每个 VectorDrawable 文件头注释中亦记录来源、seed 与许可证

| 资源文件 | seed | 背景色 | 许可证 | 需署名 |
| --- | --- | --- | --- | --- |
| `avatar_basic_01.xml` | `Sunny` | `#FFE9DF` | CC0 1.0 | 否 |
| `avatar_basic_02.xml` | `Bubble` | `#E6F1FF` | CC0 1.0 | 否 |
| `avatar_basic_03.xml` | `Mango` | `#FFF3D6` | CC0 1.0 | 否 |
| `avatar_basic_04.xml` | `Pebble` | `#E1F5EC` | CC0 1.0 | 否 |
| `avatar_basic_05.xml` | `Clover` | `#F0E9FF` | CC0 1.0 | 否 |
| `avatar_basic_06.xml` | `Nimbus` | `#FFE8F0` | CC0 1.0 | 否 |
| `avatar_basic_07.xml` | `Tulip` | `#FFE9DF` | CC0 1.0 | 否 |
| `avatar_basic_08.xml` | `Comet` | `#E6F1FF` | CC0 1.0 | 否 |
| `avatar_basic_09.xml` | `Marble` | `#FFF3D6` | CC0 1.0 | 否 |
| `avatar_basic_10.xml` | `Panda` | `#E1F5EC` | CC0 1.0 | 否 |
| `avatar_basic_11.xml` | `Lemon` | `#F0E9FF` | CC0 1.0 | 否 |
| `avatar_basic_12.xml` | `Coral` | `#FFE8F0` | CC0 1.0 | 否 |
| `avatar_basic_13.xml` | `Acorn` | `#FFE9DF` | CC0 1.0 | 否 |
| `avatar_basic_14.xml` | `Daisy` | `#E6F1FF` | CC0 1.0 | 否 |
| `avatar_basic_15.xml` | `River` | `#FFF3D6` | CC0 1.0 | 否 |
| `avatar_basic_16.xml` | `Poppy` | `#E1F5EC` | CC0 1.0 | 否 |
| `avatar_basic_17.xml` | `Glow` | `#F0E9FF` | CC0 1.0 | 否 |
| `avatar_basic_18.xml` | `Twinkle` | `#FFE8F0` | CC0 1.0 | 否 |
| `avatar_basic_19.xml` | `Cocoa` | `#FFE9DF` | CC0 1.0 | 否 |
| `avatar_basic_20.xml` | `Maple` | `#E6F1FF` | CC0 1.0 | 否 |
| `avatar_basic_21.xml` | `Breeze` | `#FFF3D6` | CC0 1.0 | 否 |
| `avatar_basic_22.xml` | `Pixel` | `#E1F5EC` | CC0 1.0 | 否 |
| `avatar_basic_23.xml` | `Honey` | `#F0E9FF` | CC0 1.0 | 否 |
| `avatar_basic_24.xml` | `Sprout` | `#FFE8F0` | CC0 1.0 | 否 |

立体头像共 **10 个**（`preset://d00` … `preset://d09`，排在 24 个基础头像之后作为高阶奖励），由 `AvatarCatalog.kt` 用 Compose Canvas 纯代码自绘「伪 3D」：径向渐变主体球、左上高光、地面投影、暗边轮廓、眼睛 / 腮红 / 微笑与 4 种头顶装饰。**不使用任何第三方素材或外部资源**，无外部许可证、无需署名、零积分。

- 基础头像为固定彩色矢量，双主题下容器、描边、选中态与文字随主题变化；头像本体保留原作配色（CC0 允许修改与商用）
- 立体头像在成人主题下背景收敛为白 / 浅绿，主体渐变保持
- 所有头像均为插画形象，不使用真人照片，不采集或推断儿童外貌信息

### 等级解锁规则

**唯一权威**：后端（DECISIONS.md D-024：教学逻辑与客户端分离）。主理人裁定：`unlockedCount = 24 + min(2 * ceil(tier / 3), 10)`、`S = Σclamp(stage,0,4)`、`tier = clamp(floor(S/2),0,14)` **全部由后端推导**；客户端只做「取前 `unlockedCount` 个」，不重算任何等级 / 曲线、不判定等级、不推断能力、不持久化解锁状态（不写 SharedPreferences、不写库、不做事件累加，重复刷新天然幂等）。

- 解锁数量**直接读取 dashboard 顶层 `unlockedCount`**（24–34）；字段缺失（旧后端）、非数字或越界时**一律回退默认值 24**，不读取 `avatarTier` 自行推算，不读取 `abilities` / `learning_evidence`。
- 固定顺序 `AVATAR_ORDER = [b00..b23, d00..d09]`，共 **34** 个：**24 个基础头像在 tier 0 即全部可选**，10 个立体头像排在最后作为高阶奖励，随档位**每 3 档解锁 2 个**（tier 0 → 24；1–3 → 26；4–6 → 28；7–9 → 30；10–12 → 32；13–14 → 34）。后端已做单调保护，降级不会重新锁定。
- 展示字段来自 dashboard 顶层 `level`（CEFR 字符串，仅展示）与 `levelProgress`：`displayLabel` / `notice` / `next.unlockAhead`（`{ tier, inTiers, additional } | null`）。**`calibrated` 缺失一律按未校准处理**，显示「参考档位 · 未校准 · 不代表掌握」；**展示档位时 `CEFR_LEVEL_NOTICE` 原文必须原样可见**，客户端内置同文兜底。禁止「已掌握」「已达到 A1」类表述。
- **锁定态只出现在 10 个立体头像上**（24 个基础头像在 tier 0 全部可选）；锁定项为中性陈述「升到下一档解锁」，配锁定图标与灰色形状。
- **解锁预告只按 `next.unlockAhead` 说明「下一次新增」发生在几档之后**：`unlockAhead != null` 时显示「再升 N 档（档位 X）可解锁 M 个立体头像」；已解锁满显示「34 个头像已全部解锁」；字段缺失显示中性「继续学习会解锁更多立体头像」，不承诺具体数量。**不使用 `next.additionalUnlocks`**——新曲线下相邻档位不一定新增（如 tier 7→8 本档为 0，下一次新增在 tier 10），直接读它会生成「升一级解锁 0 个」的误导文案。
- 文案不含损失厌恶、催促、施压或比较话术；解锁态为「可选」，选中态为「✅ 已选用」并配合彩色描边与底色，状态不只靠颜色。
- 头像网格沿用 24dp 卡片、≥48dp 触控目标、14sp 辅助文字与 `contentDescription` 语义标签；非 Lazy 网格，外层页面已有纵向滚动。

### 本地资源标识约定

- 选中头像沿用现有 `PUT /user/profile` 的 `avatarUrl` 字段，写入主理人裁定的本地标识 `preset://bNN`（`b00`–`b23`）或 `preset://dNN`（`d00`–`d09`），与 `AVATAR_ORDER` **同序同标识**；例如选中第 4 个基础头像传 `avatarUrl: "preset://b03"`。后端 `profileSchema` 已允许 `http(s)://` 外链或 `preset://`，字段名不变、不改 DB。客户端同时兼容历史格式 `preset://avatar/basic_NN` / `preset://basic/N` 等，旧值不崩。**不写入外链**，API 契约与数据模型不变。
- 兼容历史数据：若 `avatarUrl` 为既有的 http(s) 外链，客户端以中性占位头像 + 说明文字呈现，**不加载网络图片、不崩溃**；用户改选本地头像并保存后即写回 `preset://` 标识。
- 选择头像后仍需点「保存资料」提交，与原有昵称输入的提交时机一致。
- 不新增付费、会员、积分、广告、推送或打卡施压入口；解锁只由服务端解锁计数驱动，不诱导填写私人信息。

### 静态预览稿

`G:/workbuddy/英语/deliverables/gstack/avatar-gallery-preview.html`（纯 HTML + 内联 CSS/SVG，零外部依赖）展示全部 34 个头像、设计系统 token、解锁规则与逐项许可证表。基础头像的内联 SVG 由 VectorDrawable 原样反向生成，与 APK 中实际资源一致。

### 本轮新增的已知缺口

- `dashboard.unlockedCount` 与 `levelProgress`（含 `calibrated`）由后端提供；在服务端返回前客户端按默认值 24、未校准处理。字段类型与取值口径以后端契约为准。
- 34 项 `AVATAR_ORDER` 顺序与客户端 `AvatarCatalog.items` 顺序一致；若后端调整顺序，需同步客户端目录顺序。
- 头像网格为全展开的非 Lazy 布局，34 项在低端设备上的滚动流畅度**待真机验证**。
- 头像项的 TalkBack 朗读效果与整体读屏顺序**待真机验证**。
- 本轮改动**未经本地编译器验证**（开发机无 JDK / Android SDK / Gradle），**改动需重新构建 APK 才生效**。
- 客户端调用的 `/user/dashboard`、`/user/profile`、`/user/password`、`/user/textbook`、`/user/account`、`/auth/captcha`、`/auth/verify-email`、`/auth/email-verification` 尚未在 `docs/api/README.md` 逐条登记，见该文件「当前契约缺口」第 6 条。
