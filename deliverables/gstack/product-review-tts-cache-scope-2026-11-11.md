# TTS 缓存复用边界与韵律连贯性 · 决策评审报告

**日期**：2026-11-11
**场景**：产品/教学评审 + 影响面核查 + QA 发布门禁（只读决策商讨，**本轮无代码变更**）
**参与成员**：产品评审员 + 调查员 + QA/发布（软件工坊协作）
**评审对象**：提交 `05dd2c7` 的「服务端固定内容语音缓存 + 正式 Android 教师语音播放」
**基线**：`HEAD = 05dd2c7`，工作区除报告目录外无改动

---

## 📌 TL;DR（执行摘要）

- **用户主张结论成立，且这不是听感偏好之争，是规格偏差**：`DECISIONS.md:250` D-014「固定课程、词汇和标准例句预生成音频并缓存」、`:256`「固定音频进课程资源库」、`:469` **D-026**（额度耗尽本地回退优先使用课程预生成/缓存音频）本来就带「课程」scope；`05dd2c7` 把它退化成「文本 + 音色参数」全局键（`orchestrator.service.ts:1870-1876` 注释明写「在所有课堂之间复用同一份服务端音频」）。**撤回 = 回归规格基线，不是取舍**。三位成员一致支持撤回。
- **但因果归因需修正**：同一份音频字节被不同课堂引用，声学上完全相同，不会「更顿」。顿挫的真正主因是 `05dd2c7` 引入的「按 ≤120 码点切分 + 每段独立发起 TTS 请求 + Android 逐段新建 MediaPlayer」。**只给缓存键加课程 ID、禁止跨课程命中，顿挫一点都不会减少**。
- **整体结论**：🟡 决策条件 Go（接受新边界）；🔴 **当前实现 No-Go** —— QA 判定现有质量门禁完全无法证明「韵律连贯」，且 scope/owner 未落地前不得上线任何形式的跨用户音频共享。
- **两处需向用户澄清的模型修正**：① `teacherUtterance` 不能整体算课程资源，其中约一半是孩子专属内容；② `demonstrationText` 与语速/音色随孩子错误和教法变化，课程级应是**资产归属边界**，不是录死的静态音频包。
- **落地成本比初判低**：成员二轮对齐后确认，韵律止血的**最优实现是 Android 零改动**（服务端把 `segments` 改为「单条 audioRef」即可，现有 `partsFromSpeech` 天然兼容），且零 DDL；真正的成本在 scope/owner 安全门禁与测试/发布管道。
- **成员分歧基本收敛，但仍留一处需产品裁定**：产品评审员撤回「curriculumUnitId 是一节课程」、采纳调查员「运行时只能用 topicId」并补 `contentId`；但调查员在最终校准稿中仍把「发布态课程实体」写作 `curriculum_units.id` + `curriculum_drafts.version`。两者其实是「运行时作用域」与「发布态资产归属」两种口径，需定稿时统一。运行时键暂按 `(scope, topicId, contentId, contentVersion, voiceParamsHash, voiceProfileVersion, modelFamily)`，零 DDL。
- **「Android 零改动」须按校准稿收窄**：`partsFromSpeech` 主路径兼容成立，但 `TeacherSpeechController.kt:210-241` 的 `speechTexts/splitSpeech(120)/voiceBody` 是**隐藏必改点** —— 只要 `speech` 没有 segments，客户端会自行切 120 码点并 POST `/speech/cache/lookup`，仅改编排器挡不住它。此外**纯回退父提交有硬约束**：发布 schema 允许 `teacherUtteranceZh` 2000 + `demonstrationText` 5000，join 后最坏 7001 字符，直接抛错；必须先加发布审核硬拦。
- **下一步**：先定稿该规格（QA 列出的 P0 前置项），再按「韵律止血（低/零客户端改动）→ 课程级边界（低/无 DDL）→ scope/owner 安全门禁（中/需加列，跨用户共享的硬前置）」分阶段实施；是否实施需用户确认。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| Go / No-Go | 🔴 当前实现 **No-Go**（不得上线跨用户音频共享）；🟡 决策本身条件 Go |
| 定性 | **规格偏差回归**（D-014 / D-026 原本带课程 scope），非听感偏好取舍 |
| 严重度分布 | 🔴 4 / 🟠 5 / 🟡 3 / 🟢 0 |
| 关键行动项 | 8 条（见行动清单） |
| 建议负责人 | 产品（定 scope 规格）+ 后端平台（缓存键/适配器指纹）+ 客户端（播放链路）+ 发布（门禁/灰度/回滚） |
| 阻塞项数量 | 7 条（QA G1–G7，见 §6） |

---

## 1. 各成员核心结论

### 🔍 产品评审员（产品/教学）
- 核心判断：用户结论成立、因果归因错，**Go 撤回**但「不回滚 05dd2c7 整个提交」。最危险的是只改缓存键、保留 120 码点切分与逐段 MediaPlayer —— 团队会误以为问题已解决。任务书定位「像父母教孩子学母语一样」，阶段 2→4→6 本质是从离散单位走向连续语流；片段级缓存把语言建模成「可复用字符串袋子」，与七阶段连续路径方向相反，阶段 4+ 根本没有可模仿的连贯声学样本。
- 关键建议：缓存按三层划分 —— 课程层（发布时固化、人工审核、无 PII，禁止跨单元共享）、动态层（lessonSession 作用域、短 TTL）、发音资产层（单词/音素/音节 citation-form，唯一允许全局共享，且绝不拼进连续语流）。推荐方案 A「课程级资源清单 + 整轮单次合成双轨」，先 B 止血再 A 终态，C 留 M4。Kill criteria：真实儿童听感中同一轮被判定「像几段拼起来的」>10% 或阶段 4+ 出现逐词停顿模仿 → 升级到全预生成/服务端拼接。
- **终版合并结论**（覆盖前几轮所有修正，以本段为准）：① **定性升级为规格偏差** —— D-014「固定课程预生成音频进课程资源库」、D-026（`DECISIONS.md:469`，非 D-020）额度耗尽优先使用课程预生成音频，本来就带课程 scope；撤回是回归规格基线，不是听感偏好取舍。② **撤回 `curriculumUnitId`** —— `curriculum_units` 只在 admin 发布事务创建、运行时零引用；采纳调查员的 `topicId` 并补 `contentId = learning_items.content.id`（避免同主题不同活动误共享），键 = `(scope, topicId, contentId, contentVersion=sha256(row.content), voiceParamsHash, voiceProfileVersion, modelFamily)`，零 DDL。③ **收回服务端拼接方案** —— 拼接不消除韵律不连续；M1 内容 ≤30 汉字，整轮一次请求在 150 汉字 / 500 字符限额内直接可行，长文改发布审核硬拦 + 留 M4。④ **「Android 零改动」须收窄**：主路径零改动成立（服务端返回 `segments:[单条 audioRef]`，`partsFromSpeech` 天然兼容，静态守卫与 m1 集成测试不受影响），但仍有 **P1 的一处客户端 fallback 改动 + 契约改动**：`/speech/cache/lookup`（`speech.controller.ts:83-105`）与 Android `voiceBody/speechTexts/splitSpeech` 只收 text+voice，是 scope 盲区；course 模式下服务端应拒绝无 courseScope 的请求（明确 400），旧 APK 落到既有降级文案。⑤ `teacherUtterance` 横跨 PUBLIC/PRIVATE，须按「构造路径是否读到学习者数据」二分、默认 fail-closed 到 PRIVATE；实证 5 种来源中 3 种带学习者数据，整体公共化会让 B 孩子听到老师叫 A 孩子的名字（违反 D-023 与「同一位 AI 老师认识我」的连续关系）。⑥ 新增缺陷：`pauseAfterSentenceMs` 被拼进音频指纹却不写请求体、客户端不读，改它会生成**声学相同但文件名不同**的音频，重复计费 + `audioRef` 漂移，违反「反复听不重新消耗 TTS」。⑦ **验收口径收紧**：必须同时断言 `segments.length === 1` **且** `synthesisCallCount === 1`（只断言单段会被「N 次请求拼成单文件」绕过），`audioRef === segments[0].audioRef`；三个显式豁免 `segmentationReason = supplier_150_cjk_500_char_limit | published_text_overflow | signed_adapter_hard_limit` 必须带 reason 且触发告警。⑧ 成本分层：P0-A 韵律（低，主路径客户端零改动、无 DDL）/ P0-B scope/owner 安全门禁（中，需 `media_assets` 加列，**是任何跨用户共享的上线前置**，不是 P2 审计项）/ P1 边界与参数清理 / P2 gapless / M4 长文本。
- 二轮再修正（读完调查员核查后主动改口，主理人已收回归口）：① **撤回 `curriculumUnitId`** —— `curriculum_units` 只在 admin 发布事务创建，orchestrator/planner/lessons/packages 全库零引用，运行时拿不到；采纳调查员的 `topicId`，但补一层资产身份 `contentId = learning_items.content.id`（M1 内置 `act-greet-repeat-hello`，发布覆盖为 `${unit.id}:${index}`，`buildDirective:1724-1734` 本已读出 `row.content`，无需新字段），因为只有 topicId 太粗、同主题不同活动文本相同会误共享。② **收回「服务端拼接连续音频」方案** —— 拼接不消除韵律不连续；真实供应商上限是 150 汉字/500 字符，而 M1 内容 ≤30 汉字，整轮一次请求直接可行，长文改发布审核硬拦 + 留 M4。③ **方案 A 最优实现是 Android 零改动** —— 服务端返回 `segments:[单条 audioRef]` 即可，`partsFromSpeech` 天然兼容，静态守卫与 m1 集成测试的「无会话直连」坑都不会被触发，gapless 降为 P2。④ 新增缺陷：`pauseAfterSentenceMs` 被拼进音频文件指纹却不写请求体、客户端不读，改它会生成**声学相同但文件名不同**的音频，重复 TTS 计费 + audioRef 漂移，直接违反「反复听不重新消耗 TTS」硬指标。⑤ 成本分层：P0-A 韵律（低，零客户端改动、无 DDL）/ P0-B scope/owner 门禁（中，需 `media_assets` 加列，是任何跨用户共享的上线前置而非 P2 审计项）/ P1 边界（低、无 DDL）/ P1 参数清理 / P2 gapless / M4 长文本。

### 🔧 调查员（影响面/根因）
- 核心判断：**唯一能真正消除顿挫的是 ②B「一轮教师话语用一次 TTS 请求合成、返回单一 audioRef」**；服务端把多段拼成单文件只能消掉客户端间隙、恢复不了跨句语调；仅改缓存键或仅声明片段归属对韵律 0 改善。P0=②B、P1=①（缓存键作用域）、P2=③（显式声明归属，仅审计价值）。
- 关键建议：项目**没有 `course` 实体**（全库 grep courseId 0 命中），运行时可用且稳定的作用域是 `topicId`（存在于 `lesson_sessions.topicId`、`LessonStartResponse.topicId`、`learning_items.topicId`、`curriculum_units.topicId`）；`curriculum_units` 是发布态单元但编排器完全不引用，`directive` 里没有任何 ID，`synthesize()` 拿不到课程 ID 需透传。**绝不能用 `lessonSessionId`** —— 那是课堂实例，每次开课新建，会摧毁跨用户/跨时间复用。仅加作用域无 DDL。产品评审员二轮已撤回自己「curriculumUnitId 是一节课程」的判断并采纳该结论，另补 `contentId` 作为活动级资产身份。
- 补充实证：`pauseAfterSentenceMs` 完全惰性（无任何适配器写入 TTS 请求体，`http.ts:60` 明确属播放端行为，客户端也不读），只扰动缓存键/文件名；Android `playParts` 每段新建 `MediaPlayer`、无 `setNextMediaPlayer`；**Web 端 `page.tsx:729-735` 完全忽略 `segments`，只播第一片段，静默丢失第 2..N 段**；适配器层还有第二层全局去重（`signed-tts.ts`/`http.ts` 的 24-hex 文件名是**请求参数指纹 `sha256(text, speed, model, voice)`，不是音频字节哈希**，校准稿已更正 QA 的措辞），所以「加作用域」只改变是否命中/计费，不阻止物理文件共享；修复反而更简单 —— 把 scope 注入适配器指纹输入即可。M1 实际内容 ≤30 汉字，一次请求在现有限额内直接可行。
- 最终校准稿另补四点：① `tts-segments.ts:10` 断点正则**不含逗号**、回溯区间 60–119 码点，长句常在任意空格硬切（可能切在冠词/名词、助动词/动词之间）；② `demonstrationText` 来自 `resolveDemonstration(errorUnits)`，且 `teacherSpeed` 由 `teacher_profiles.adjustable.speakingRate`、`voiceStyle` 由 teacher_profile tone、`pronunciationMode` 由 methodState 决定 —— **voice 参数随学习者/教法变**，故课程级键必须含 `voiceParamsHash`，同一段 PUBLIC 文本也不能全课程共用一个音频；③ 收窄产品评审员第 5 种来源：`personaHint` **不进入合成文本**，只用于 directive 展示，TTS 的 PRIVATE 来源实为 3 个（`previousTopicName`、`answer.text`、`demonstrationText`）；④ `tts-cache.test.ts:154-157` 用例名含「跨课堂复用」但断言本身中性，建议**改名保留断言**，而非整条删除。

### ✅ QA/发布（门禁）
- 核心判断：🔴 **No-Go**。缓存键与适配器 `audioRef` 指纹均不含课程/版本标识；现有 8 项 TTS 缓存测试至少 4 处与新决策冲突或需反向改写（`tts-cache.test.ts:154` 把「跨课堂复用」写成测试目标、`:140-146` 断言「长文章必切多段」正是顿挫来源）；`android-client.yml` 只有 assemble，仓库 0 个 Android 测试源码、0 个音频 fixture。不得以 CI 绿 / assemble 通过放行。
- 关键建议：「无顿挫」写成**构造性断言**（一段话术 = 1 个音频文件 → 段间隙恒为 0），而非「听感自然」或间隙阈值（客户端 prepareAsync 抖动 + 蓝牙 A2DP 延迟不可在 CI 复现）。给出 A1–A10 自动化断言、M1–M7 跨用户验收矩阵、H1–H5 人工/真机听测签核、G1–G7 Go/No-Go 门禁、Phase 0–3 灰度与**逻辑失效不物理删除**的回滚方案。特别指出 A6「音色版本变更失效」当前会静默返回旧音频（适配器指纹不含版本，`existsSync` 跳过写盘），是最有价值的一条新门禁。

> 设计师未上场；安全官本轮未上场，其上一轮「PUBLIC_CURRICULUM / PRIVATE_* 分 scope」结论由主理人中转给产品评审员与 QA 并纳入评审。

---

## 2. 综合审查发现（去重合并后按严重度排序）

| # | 严重度 | 类别 | 位置 | 问题描述 | 建议 | 来源成员 |
|---|--------|------|------|---------|------|---------|
| 1 | 🔴 | 教学/韵律 | `orchestrator.service.ts:1877-1879`、`tts-segments.ts:10`、`TeacherSpeechController.kt:210-248` | 按 ≤120 码点切分（断点正则**不含逗号**、回溯 60–119 常在冠词/名词或助动词/动词之间硬切）+ 每段独立 TTS 请求 + 逐段新建 MediaPlayer，段首音高重置、跨段语调/协同发音丢失、解码器空洞；**这是 05dd2c7 引入的回归**，`05dd2c7^` 原本是单次合成 | 回整轮单次合成、服务端返回 `segments:[单条 audioRef]`（`partsFromSpeech` 主路径天然兼容）；**但 Android `speechTexts/splitSpeech(120)/voiceBody` fallback 必须同步改**，否则无 segments 时客户端仍会自行切段；先加发布审核硬拦（发布侧 2000+5000 最坏 7001 字符，纯回退父提交会抛错）；保留 N 段兼容路径至回滚期结束；gapless 降为 P2 | 三人一致 |
| 2 | 🔴 | 隐私/合规 | `speech.controller.ts:83-105`、`media.controller.ts:78-120`、`schema.prisma:592-613` | `teacherUtterance` 约一半含孩子姓名/原话/学习历史/个性化反馈；`/speech/cache/lookup` 无 owner 过滤、`GET /media/audio/:file` 只校验「调用者拥有所声称 learnerId」+ 租约、儿童录音与 TTS 音频同目录且无 owner | 按构造路径二分 scope、默认 fail-closed PRIVATE；PUBLIC 仅发布期预生成、运行时只读；补 owner + expiresAt + 归属校验 + 目录隔离 | 产品评审员（承接安全官 scope 模型） |
| 3 | 🔴 | 缓存正确性 | `ai-gateway.service.ts:385-392`、适配器指纹 `vendor-speech.ts:185`、`vendor-tencent-cloud.ts:99` | 缓存键与 `audioRef` 指纹均不含课程/版本；键注释明确「不含供应商或模型标识」，与任务书「切换模型须检查音色/口音一致性」冲突；升 `TTS_VOICE_PROFILE_VERSION` 后 gateway miss 但适配器算出同名文件、`existsSync` 跳过写盘 → **静默复用旧音频** | gateway 键与适配器指纹**同时**加 scope + voiceProfileVersion/modelFamily；仅改 gateway 不足以落地新决策 | QA + 产品评审员 + 调查员 |
| 4 | 🔴 | 发布门禁 | `.github/workflows/ci.yml:106-122`、`android-client.yml:57-75`、`publish-docker.yml` | 显式清单不含新测试则永不执行；Android 仅 assemble 无 test/lint/instrumented；publish 与 CI 同为 main push 且无 `needs`，CI 红仍推 `latest` | 新增 3 个离线测试文件并列入清单；Android 加 test/lint/instrumented；publish 加 `needs:[CI]` + 绑定已验收 SHA/digest | QA |
| 5 | 🟠 | 契约/兼容 | `apps/web/app/page.tsx:729-735` | Web 完全忽略 `speech.segments`，只播首段 → 第 2..N 段静默丢失 | 验收矩阵覆盖 Web 与 Android；单文件设计下该问题自然消失 | 调查员 / QA |
| 6 | 🟠 | 测试正确性 | `tts-cache.test.ts:50-51,93`、`:108-115`、`:140-157`；`m1-api.integration.test.ts:61-77` | mock 对所有文本返回同一固定 audioRef → A4「不同课程不同 audioRef」结构性测不出；「音色版本变化可整体失效」用例名承诺能力但正文未测；m1 集成测试在 `/lessons/start` 之前直连 synthesize、无活跃会话，服务端派生 scope 无兜底会 400 | 改造 mock 按 (text,scope) 派生字节；补 A6/A4/跨用户/慢速负向断言；scope 派生需有兜底且取稳定值 | QA + 调查员 |
| 7 | 🟠 | 参数惰性 / 重复计费 | `http.ts:60`、`signed-tts.ts:210-225,307`、`ai-gateway.service.ts:389`、`TeacherSpeechController.kt` | `pauseAfterSentenceMs` 未写入任何 TTS 请求体、客户端不读，却同时进入缓存键与适配器音频文件指纹 → 改该参数会生成**声学完全相同但文件名不同**的音频，重复 TTS 计费且 `audioRef` 漂移，违反「反复听不重新消耗 TTS」硬指标；「段间波形间隙等于该参数」目前也是尚未实现的能力 | 从音频指纹中移除不影响声学结果的参数，并在缓存键中按语义归一化；补一条「参数变化不产生新音频文件」断言；句间停顿需客户端显式实现或换支持 SSML 的供应商 | 产品评审员 / 调查员 / QA |
| 8 | 🟠 | 回滚/失效 | `.cache/audio/.tts-*.json`、`ai-gateway.service.ts:394-438` | 索引不校验 keyVersion/courseId/audioSha256，损坏文件（存在但乱码/截断）会被判命中下发；旧格式明文索引未清理；仓库存在两处 split-brain 缓存目录（根 1 索引 0 音频、backend 12 mp3） | 索引加字段校验 + 音频字节校验；键版本升位做逻辑失效，旧索引/音频归档保留整个回滚窗口、**不物理删除**；部署设绝对 `AI_AUDIO_DIR` | QA |
| 9 | 🟠 | 产品降级风险 | `orchestrator.service.ts:1778`、`:189-193`、`:775-781`；`method-ladder.ts:175` | 若把「这节课运行时老师说过的所有话」做成静态预生成包，等于为缓存把自适应教学降级成固定录音（demonstrationText 由孩子 errorUnits 导出，teacherSpeed/voiceStyle 随教法与学习者变） | 课程级只作资产归属边界 + 版本化清单，动态层保留会话作用域 | 产品评审员 |
| 10 | 🟡 | 编码/成本 | `speech.controller.ts:20`、`router.ts:124`、`signed-tts.ts:179-186` | 真实供应商单次上限 150 汉字 / 500 字符，长文章无法单次合成；服务端拼接 MP3 需新代码、WAV 要重写 RIFF 头、无 ffmpeg 依赖，且**不恢复跨段韵律**（该方案已由产品评审员收回） | M1 实际内容 ≤30 汉字，整轮一次请求直接可行；M1/M2 发布审核硬拦 ≤150 汉字 / ≤500 字符；长文章留到长文本/流式 TTS 供应商（M4） | 调查员 / 产品评审员 / QA |
| 11 | 🟡 | 额度语义 | `speech.controller.ts:83-106` vs `media.controller.ts:103-116` | `cache/lookup` 免租约但音频下载仍要租约，「命中缓存是否仍需租约」语义不一致 | 产品定夺；M7 额度不足降级需明确（D-020 优先播放课程预生成音频） | QA |
| 12 | 🟡 | 可测性 | `admin-console-static-guard.test.ts:10-21` | 全部为源码文本启发式，明确不能证明运行时行为；`:173-192` 路径集合精确相等 + 三条 `fun play` 正则锚点与「移除纯文本 lookup / 单文件播放」直接冲突 | 有意识更新常量与锚点（不放宽判定），并显式标注其不能作为「无顿挫」验收证据 | QA / 调查员 |

---

## 交付清单（决策规格 + 测试覆盖 + 发布检查清单 + 回滚预案）

### 本轮无代码变更
三位成员全程只读：`HEAD` 仍为 `05dd2c7`，未提交、未触发工作流、未访问生产或数据库、未调用任何 LLM/供应商 API。本轮交付物仅为决策评审。

### 决策规格（需用户/产品定稿，QA 列为 P0 前置）
1. **作用域**（成员二轮已收敛，仍需产品最终签核）：`scope = {topicId, contentId = learning_items.content.id, contentVersion = sha256(row.content), voiceParamsHash, voiceProfileVersion, modelFamily}`；**不得含** `userId/learnerId/lessonSessionId/timestamp`（含了会破坏跨用户复用）。`topicId` 是运行时唯一可得的稳定主题标识；`contentId` 补活动级资产身份，避免同主题不同活动文本相同误共享；`contentVersion` 用内容哈希而非 `curriculum_drafts.version`（后者编排器不引用）。**`curriculum_units.id` 与 `lessonSessionId` 均不作为课程边界**：前者只在 admin 发布事务创建、运行时零引用，后者是每次开课新建的课堂实例。`buildDirective:1724-1734` 本已读出 `row.content`，透传无需新增字段，零 DDL。
2. **scope 分层**：PUBLIC_CURRICULUM（发布期固化 + 人工审核 + 无 PII，运行时只读不写）/ PRIVATE_DYNAMIC（默认 fail-closed，带 owner + expiresAt + 自动清理）/ PRONUNCIATION（唯一允许跨课程共享的 citation-form 示范，独立命名空间且必须含 modelFamily + voiceProfileVersion，绝不拼进连续语流）。
3. **韵律形态**：一个课程话术 = 一个音频文件（`segments.length === 1`），整轮单次合成；`segments` 保持 optional 且元素形状不变，`audioRef` 保留作向下兼容锚点。
4. **音色版本**：`modelFamily` 是否纳入键、`TTS_VOICE_PROFILE_VERSION` 是否随模型切换递增，必须先裁定 —— 当前 `ttsCacheKey` 注释「不含供应商或模型标识」与「音色版本变更整体失效」互相矛盾，不裁定则 A6 无法写。
5. **长文与回退硬约束**：M1 单次合成可行（≤30 汉字）；但发布 schema 允许 `teacherUtteranceZh` 2000 + `demonstrationText` 5000，join 后最坏 7001 字符，签名型适配器 150 汉字 / 500 字符会直接抛错 —— **纯回退 `05dd2c7^` 会让已发布长课程崩**，必须先加发布审核硬拦 ≤150 汉字 / ≤500 字符；长文章留 M4 长文本/流式 TTS。
6. **验收口径**：`segments.length === 1` **且** `synthesisCallCount === 1`、`audioRef === segments[0].audioRef`；三个显式豁免 `segmentationReason` 必须带 reason 且触发告警。voice 参数（`teacherSpeed`/`voiceStyle`/`pronunciationMode`）随学习者与教法变，故 PUBLIC 键也必须含 `voiceParamsHash`。

### 测试覆盖（实施前必须补齐，QA §5）
- 新增 `tts-scope.test.ts`（A4/A5/A6）、`prosody-contract.test.ts`（A1/A7）、`tts-audio-fixture.test.ts`（A8 + 可选 A2），**全部离线、不调外部 TTS/LLM**，并同时加入 `ci.yml` 显式清单。
- 产出并提交 ≥20 条 golden 课程话术语料 + 对应单一期望音频 fixture（仓库当前 0 个音频文件）。
- 改写 `tts-cache.test.ts` 4 处冲突断言、`m1-api.integration.test.ts` 补跨用户/跨课程/慢速负向/重启/revision/segments 端到端、同步 `admin-console-static-guard.test.ts` 常量与锚点。
- Android 在「零改动」方案下仍建议抽离 `partsFromSpeech/splitSpeech/safeRef/rateOf` 为可测单元 + JVM 单测（A10），instrumented 播放用例随 gapless 一并降为 P2；二轮对齐后 `admin-console-static-guard` 的路径集合与 `fun play` 锚点、以及 m1 集成测试的「无会话直连 synthesize」坑都不会因服务端作用域派生而触发，但仍需保留三态兼容（segments 缺失 / 1 项 / N 项）回归。
- 补一条独立断言：不影响声学结果的 voice 参数（尤其 `pauseAfterSentenceMs`）变化不得产生新音频文件、不得重新计费。
- 人工听测 H1–H5：MOS ≥ 4.0（≥5 名评审含 ≥1 名儿童英语/语音专业人士）、ABX 盲听无拼接感偏好、英语节奏主观项、真机矩阵、6–9 岁儿童小组试听。

### 发布检查清单（G1–G7，任一不满足 = No-Go）
- **G1 🔴P0** 自动化断言 + 改写后测试在 ci.yml 显式清单全绿；**G2 🔴P0** Android `gradle test` + `lint` + instrumented 通过、H4 真机矩阵无阻断；**G3 🔴P0** H1–H5 人工听测签核。
- **G4 🟠P1** canary：新增 console error = 0、音频下载失败率不高于基线、同课程首用户供应商调用=1 后续=0、首播 p95 退化 ≤10%、TTS 成本/有效目标退化 ≤5% 或书面豁免。
- **G5 🔴P0** `publish-docker.yml` 加 `needs:[CI]` + 绑定已验收 SHA/digest；**G6 🟠P1** staging 回滚演练；**G7 🟠P1** 缓存失效脚本 dry-run 输出。

### 回滚预案
- **逻辑失效，不物理删除**：`'tts-v2'` → `'tts-v3-course'` 并加入 courseId/revision 后，旧索引文件名再也不会被计算出来 → 天然不可达；但回滚窗口内 `TTS_CACHE_SCOPE=global` 需重新读 v2 索引与音频，故隔离归档 + 14 天 / 2 个发布周期后 GC，加 `.tts-scope-epoch` 标记。
- **音频不按文件名删除**：24-hex 文件名是请求参数指纹（非字节哈希），多个课程/索引可能指向同一文件；失效只做孤立索引，音频按引用计数/TTL 后台回收。把 scope 注入适配器指纹输入即可让不同课程得到不同文件名，无需音频处理依赖。
- **双读双写灰度**：Phase 0 影子双写仍返回 v2 形状 → Phase 1 服务端按 courseId 白名单 5%→50%→100%（响应保持 `audioRef`/`segments` 形状不变，仅 additive `speech.scope`）→ Phase 2 客户端 Play 分阶段（不得按 learnerId 分流）→ Phase 3 收口保留 global 读回退一个周期。
- **三态兼容**：新客户端须容忍 segments 缺失 / 1 项 / **N 项（回滚期旧服务端）**，不得在同一发布删除 `playParts`；旧 APK 的 `JSONObject.optString` 忽略未知键天然兼容。course 模式拒绝无 courseScope 的纯文本请求时，旧 APK 落到既有「请先阅读课堂文字」降级需写入灰度风险说明。
- **DB**：`media_assets` 加可空 `scopeKey/courseId/contentRevision/keyVersion` 属加列式迁移，无需回滚 DDL；若改按课程分路径，需同步改 `media.controller.ts:18-21`、`backup.service.ts:151/155`、`TeacherSpeechController.kt` 下载白名单、`ai-gateway.service.ts` 索引路径 4+ 处。
- **整体回退**：`git revert 05dd2c7` 可回退业务代码；本决策本身不引入 DDL（仅作用域与韵律时成立）。

---

## ✅ 行动清单

| # | 行动 | 负责方 | 紧急度 | 期望完成 |
|---|------|--------|--------|---------|
| 1 | **定稿 scope 规格**：裁定 `courseId` 取 `topicId` 还是 `curriculum_units.id`+version、revision 取值口径、`modelFamily` 是否入键并解决与「不含供应商标识」注释的矛盾；写成可断言规格后再动代码 | 产品 + 后端平台 | P0 | 编码前 |
| 2 | **止血韵律（Android 可零改动）**：把 `synthesize()` 回退为整轮单次合成、服务端返回 `segments:[单条 audioRef]`；现有 `partsFromSpeech` 天然兼容，保留 N 段兼容路径至回滚期结束；停用 `synthesize()` 中的 120 码点切分（工具函数保留给长文语义切分）；gapless 降为 P2 | 后端为主（客户端无需发版） | P0 | 规格定稿后首个迭代 |
| 3 | **落地课程级作用域**：gateway 缓存键 + 适配器 `audioRef` 指纹**同时**加 scope/voiceProfileVersion；索引加 keyVersion/courseId/audioSha256 校验并拒绝旧格式；PUBLIC 仅发布期预生成、运行时只读 | 后端平台 | P0 | 与 #2 同批或紧随 |
| 4 | **scope/owner 治理独立排期**：`media_assets` 加 scope/owner/expiresAt、`GET /media/audio` 与 `/speech/cache/lookup` 补归属校验、儿童录音与 TTS 音频目录隔离；**未落地前不上线任何跨用户音频共享** | 后端平台 + 安全 | P0 | 跨用户共享上线前硬门槛 |
| 5 | **改写冲突测试并补门禁**：反向改写 `tts-cache.test.ts` 4 处断言、m1 集成测试补跨用户/跨课程/慢速负向、新增 3 个离线测试并列入 ci.yml 显式清单、Android 加 test/lint/instrumented、产出 golden 语料与音频 fixture | QA + 实现 | P0 | 与 #2/#3 同批 |
| 6 | **修发布管道**：`publish-docker.yml` 加 `needs:[CI]` + 绑定已验收 SHA/digest（本次 scope 变更必须先修） | 发布负责人 | P0 | 编码前 |
| 7 | **人工听测签核**：MOS ≥4.0、ABX 盲听、6–9 岁儿童小组试听、真机矩阵（含蓝牙 A2DP、退后台、快速连点） | 产品 + QA | P0 | 灰度前 |
| 8 | **灰度与回滚演练**：Phase 0–3 双读双写、逻辑失效 dry-run、staging flag 切回 global 演练、三态兼容交叉联调（旧 APK × 新服务端 / 新 APK × 旧服务端） | 发布 + 客户端 | P1 | 上线前 |

---

## ⚠️ 待完善 / 已知局限

- **本轮只做决策评审，未改代码**：用户说的是「值得商讨」，因此 `05dd2c7` 保持不动；是否实施、按哪个范围实施需用户确认。
- **仍有一处口径待裁定**：产品评审员撤回 `curriculumUnitId`、采纳运行时 `topicId` 视角，但调查员最终校准稿仍把「发布态课程实体」写作 `curriculum_units.id` + `curriculum_drafts.version`。这不是事实冲突，而是「运行时作用域」与「发布态资产归属」两种口径，定稿时需明确各自用途。DDL 成本的两种口径同理：仅韵律 + 课程作用域零 DDL，同时做 scope/owner/expiresAt 治理才需 `media_assets` 加列。另需签核 `modelFamily` 是否入键。
- **P2 排期分歧**：调查员把「显式声明片段归属」列为 P2 仅审计价值（纯韵律视角），产品评审员把 scope/owner 绑定列为 P0-B 上线前置（儿童隐私视角）。主理人采信后者作为门禁：任何形式的跨用户音频共享上线前必须先落地 owner 绑定。产品评审员曾直接向调查员发送合并优先级，主理人已把该跨成员信息收回并统一中转。
- **QA 一条措辞已被校准**：适配器 24-hex 文件名是请求参数指纹 `sha256(text, speed, model, voice)`，不是音频字节哈希；实用后果（跨作用域共享物理文件）相同，但修复只需把 scope 注入指纹输入，不需要音频拼接/ffmpeg。
- **方案 A 成本口径已下调**：核心改动只是回到 `05dd2c7^` 的单次合成形状，M1 内容 ≤30 汉字在现有限额内直接可行，且 Android 可零改动；成本主要在 P0-B 的 scope/owner 安全门禁与测试/发布管道，而非客户端。
- **长文章仍无解**：签名型适配器 150 汉字 / 500 字符硬限，服务端拼接方案已收回（不恢复跨段韵律且无 ffmpeg 依赖），需长文本/流式 TTS 供应商（M4）；M1/M2 期间用发布审核硬拦。
- **`pauseAfterSentenceMs` 需单独清理**：它当前污染缓存键与音频文件指纹但不产生声学差异，会造成重复 TTS 计费与 `audioRef` 漂移，是「反复听不重新消耗 TTS」硬指标的独立破坏项。
- **QA 门禁是设计而非已实现**：G1–G7、A1–A10、M1–M7 均为「应写成什么」，不是已落地的断言；`admin-console-static-guard` 自述只是源码文本启发式，不得作为「无顿挫」证据。
- **上一轮遗留未解**：本机无 JDK/Gradle，`Android Formal Client` 工作流结果未能即时回收（`api.github.com` SNI 拦截）；`publish-docker.yml` 未依赖 CI。
- **安全官本轮未上场**：其上一轮 scope 模型经主理人中转后被产品评审员采纳并补强，未做本轮独立安全复审；既有媒体 ACL / 租约可重放债建议独立排期，不混入本次 scope 变更。

---

## 📚 成员产出索引

- `gstack-product-reviewer`（产品评审员）：任务 #1 主报告（Go 撤回、顿挫来源四级归因、三层缓存边界、方案 A/B/C、七阶段连续路径影响、Kill criteria）+ 补充评审（teacherUtterance 5 种来源实证、scope 二分与 fail-closed、共享白/黑名单、两处结论修正、发布硬门槛）+ 二轮再修正（撤回 curriculumUnitId、收回服务端拼接方案、Android 零改动判定、pauseAfterSentenceMs 指纹污染、成本分层）。
- `gstack-investigator`（调查员）：任务 #2 只读核查报告（课程实体与稳定 ID 候选、缓存键与持久化层确认、改动清单与 DDL、逐段顿挫具体行号、500 字上限与长文路径、三方案成本、05dd2c7 测试影响）+ 最终校准稿（更正 QA 的「字节哈希」措辞、收窄 personaHint 来源、隐藏的 Android fallback 必改点、纯回退父提交的 7001 字符硬约束、voice 参数动态性、测试断言处置细化）。
- `gstack-qa-lead`（QA/发布）：任务 #3 独立门禁报告（A1–A10 自动化断言、M1–M7 验收矩阵、H1–H5 人工听测、现有测试冲突清单、Phase 0–3 灰度、逻辑失效回滚、G1–G7 Go/No-Go、实施前 P0/P1/P2 前置清单）。
- 主理人：跨成员信息中转（安全官 scope 模型 → 产品评审员/QA；产品评审员事实基线 → 调查员；产品评审员验收口径与成本修正 → QA/调查员；调查员 Web 丢段与集成坑 → QA）、差异仲裁、报告汇编与收口。

---

> 本报告由软件工坊 AI 协作生成，关键决策请由工程负责人复核。
