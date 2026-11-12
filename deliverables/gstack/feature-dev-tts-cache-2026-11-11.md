# 正式 Android 教师语音播放与课程固定内容语音缓存 · 交付报告

**日期**：2026-11-11
**场景**：全流程交付（产品/架构评审 → 代码实现 → 安全审计 → QA 门禁 → 收口）
**参与成员**：产品评审员 + 排障/实现 + 安全官 + QA/发布（软件工坊协作）
**提交**：`05dd2c7 feat: connect teacher TTS playback and server-side curriculum speech cache`（已推送 `origin/main`）

---

## 📌 TL;DR（执行摘要）

- 整体结论：🟡 **有条件通过** —— 功能链路已落地、后端 TypeScript 全量类型检查与 195 个单元测试通过；**Android 端因本机无 JDK/SDK/Gradle 未能本地编译**，需以云端正式客户端工作流为准。
- 阻塞项：1 项（云端编译/真机播放尚未回收结果）；另有 2 项既有安全债需独立排期，不属本次改动引入。
- 服务端缓存不是从零新增：repo 已有内存 + `.tts-<sha256>.json` 磁盘索引；本次把它加固为「先查缓存 → 命中复用 → 未命中才合成」，并让固定单词/短句/文章按稳定片段独立缓存。
- 专家团多名成员因 **403 预扣额度失败** 中断，独立终验未完整执行；相关成员产出仅采信其已实际返回的部分，未代写未完成的报告。

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| Go / No-Go | 🟡 **条件 Go** —— 以 GitHub Actions `Android Formal Client` 编译通过为前置 |
| 严重度分布 | 🔴 1（待编译/真机）/ 🟠 2（既有安全债：媒体 ACL、租约可重放）/ 🟡 3（多实例去重、对象存储生命周期、发布门禁）/ 🟢 0 |
| 关键行动项 | 5 条（见行动清单） |
| 建议负责人 | Android 客户端负责人 + 后端平台负责人 + 发布负责人 |

---

## 1. 各成员核心结论

### 🔍 产品评审员（产品/架构）
- 核心判断：原编排器 `orchestrator.service.ts:1869` 把 `teacherUtterance + demonstrationText` 拼成**一条** TTS 文本，因此「只预生成 hello / 短句 / 文章本体」永远命中不了课堂那次调用，不能声称节省供应商请求。
- 关键建议：必须选择「预热实际组合文本」或「拆成稳定片段 manifest，客户端顺序播放」；最终采纳后者，并顺带修复「缓存命中却按当前路由重标 provider/model、degraded 恒 false」的来源语义缺陷。成员最终报告因 403 额度失败未完整交付，此处仅引用其已实际发回的关键结论。

### 🔧 排障/实现（Android）
- 核心判断：正式端此前**完全没有音频消费链路**（`MainActivity.kt` 无 MediaPlayer、未读 `lesson.speech`），不是后端缺 TTS。
- 关键产出：`TeacherSpeechController.kt` 初稿（生命周期串行取消、租约/下载、重播本地复用），并明确指出 `http` 可见性、`onRecord` 同步 lambda、`LearnScreen` 回放按钮三处编译阻断；后因 403 额度中断，由主理人接手整合。

### 🛡️ 安全官（OWASP + STRIDE）
- 核心判断：现有全局 TTS 缓存不是「没有缓存」，而是缺 single-flight、缓存键版本/来源不完整、索引明文保存文本、Mock 结果可能被当成正式音频长期固化；并复现了 5 个并发相同请求触发 5 次供应商调用。
- 关键建议：按「固定课程公开发布内容」与「动态/私人文本」分 scope、键包含结构化版本、原子写索引、只读索引不存原文、租约与实际供应商调用解耦；已确认的媒体 ACL 与租约重放属既有跨模块问题，不在本次静默重构。

### ✅ QA/发布（只读门禁）
- 核心判断：APK 能编译 / CI 绿 **不等于** 教师语音与持久缓存验收通过。正式 Android 工作流仅 `assemble` + 上传 APK，无 lint/单测/真机；本机 Java/Gradle/adb 全部缺失。
- 关键建议：补冷并发、重启持久、缺失文件、文章 > 500 字、真实 start/turn 编排预热后供应商调用 = 0；本地重播零网络；剩余额度 < 120 秒但足够短音频时应可播放。`publish-docker.yml` 与 CI 同为 main push 触发且无 `needs` 依赖，CI 红时仍可能推 `latest`。

---

## 2. 综合审查发现（去重合并后按严重度排序）

| # | 严重度 | 类别 | 位置 | 问题描述 | 建议 | 来源成员 |
|---|--------|------|------|---------|------|---------|
| 1 | 🔴 | 编译/验收 | `apps/android/**` | 本机无 JDK/SDK/Gradle，Kotlin 编译级正确性只能靠云端工作流证明 | 以 `Android Formal Client` 为准，编译后再补真机播放矩阵 | QA |
| 2 | 🟠 | 安全（既有） | `media.controller.ts:78-119` | 私人录音与公共 TTS 共目录、下载无资产归属校验，B 用本人有效租约可读 A 的已知文件名 | 公共课程 / 私人上传分区 + 资产 ACL + 短 TTL | 安全官 |
| 3 | 🟠 | 安全（既有） | `speech.controller.ts:151-204` / `speech-quota.service.ts:198-225` | 客户端自报租约、可 settle(0)/release、同租约可反复 assert | 服务端原子 claim 与实际用量账本绑定，客户端只上报播放统计 | 安全官 |
| 4 | 🟡 | 缓存一致性 | `ai-gateway.service.ts:364-370` | 旧键用 `join('|')` 易碰撞、无音色版本、命中按当前路由重标供应商 | 已改 JSON 结构化键 + `TTS_VOICE_PROFILE_VERSION`，命中返回真实来源/降级 | 安全官 / 产品评审员 |
| 5 | 🟡 | 并发 | `ai-gateway.service.ts:277-284` | 冷缓存并发会重复付费生成（离线复现 5/5） | 已加进程内 single-flight；多实例仍需分布式锁/原子临时文件 | 安全官 |
| 6 | 🟡 | 发布门禁 | `.github/workflows/publish-docker.yml` | 与 CI 同为 main push 触发且无 `needs`，CI 红仍可能推 `latest` | 发布加 `needs: [CI]` 且绑定已验收 SHA/digest | QA |
| 7 | 🟡 | 长文本 | `speech.controller.ts:19-27` | `synthesize` 文本上限 500，文章 > 500 码点无法一次合成 | 已由编排器按标点切成 ≤120 码点稳定片段并逐段缓存 | 产品评审员 / QA |

---

## 交付清单（代码变更 + 测试覆盖 + 发布检查清单 + 回滚预案）

**代码变更（13 文件 / +942 −127）**

- `apps/android/app/src/main/java/com/alg/languagegrowth/TeacherSpeechController.kt`（新增）：教师语音片段顺序播放、生命周期停止/释放、下载白名单（同源 HTTPS + 24 位指纹 + 三扩展名）、"再听一次" 本地零网络重播、按实际播放时长结算 / 失败 NonCancellable 释放租约、旧回调用 generation 防止串音。
- `apps/android/app/src/main/java/com/alg/languagegrowth/MainActivity.kt`：接入 `lessonSpeech / speechStatus / speechBusy`、开课与 turn 保存 `speech`、自动播放与切换指令时停止、课堂页新增语音状态与「再听一次」按钮、录音权限时序与编译阻断修复、`http` 改 `internal` 供控制器复用、ASR 租约按实际录音时长估算。
- `apps/android/app/src/main/AndroidManifest.xml`：`RECORD_AUDIO`（上一轮已加，本次一并提交）。
- `apps/android/app/build.gradle.kts`：显式声明 `kotlinx-coroutines-android:1.8.1`（Apache-2.0，本已由 lifecycle-runtime-ktx 传递引入）。
- `services/backend/src/ai-gateway/ai-gateway.service.ts`：新增 `peekTtsCache()` 只读探测、`ttsInFlight` 单进程 single-flight、`findTtsCache()` 复用、缓存保存真实 outcome（来源/降级/语速）、结构化键 + 音色版本、索引改 SHA256 文本摘要 + 原子 rename、Mock 不可播放引用只留在内存、1000 条 LRU 上限。
- `services/backend/src/speech/tts-segments.ts`（新增）：按标点无损切成 ≤120 码点稳定片段。
- `services/backend/src/speech/speech.controller.ts`：新增 `POST /api/v1/speech/cache/lookup`（只读查缓存，本人 Bearer + `X-Learner-Id`，不触发供应商、不需租约）。
- `services/backend/src/orchestrator/orchestrator.service.ts`：`synthesize()` 改为「教师引导 + 固定示范内容」分开、各自分段合成，返回 `speech.segments`；旧 `audioRef` 保留作兼容首位片段。
- `packages/shared-contracts/src/teaching.ts`：`speech.segments` 可选字段。
- `services/backend/test/tts-cache.test.ts`（新增）：8 项回归（冷缓存探测、并发只生成一次、命中不计费、参数区分、重启磁盘恢复且索引无明文、文章无损分段、中文断句、短词短句单段）。
- `services/backend/test/admin-console-static-guard.test.ts`：锚点集合改为「基线 + 课堂/教师语音端点」且新增三条教师语音断言（不是放宽标准，而是把新增正式功能纳入必检）。
- `.github/workflows/ci.yml`：显式单测清单加入 `tts-cache.test.ts`。
- `apps/android/README.md`：同步 TTS 已接入、版本 `0.0.3 / code 3`、缓存优先播放顺序。

**测试覆盖 / 验证证据**

| 验证 | 命令 | 结果 |
|------|------|------|
| 全量 TypeScript 类型检查 | `npm run typecheck` | ✅ 退出码 0（8 个 workspace 全通过） |
| 后端编译 | `npm run build --workspace @alg/backend` | ✅ 退出码 0 |
| 共享契约 / 语音 SDK 编译 | `npm run build --workspace @alg/shared-contracts` / `@alg/ai-provider-sdk` | ✅ 退出码 0 |
| CI 显式单元测试清单 | `npx tsx --tsconfig services/backend/tsconfig.json --test <16 项>` | ✅ **195 / 195 通过，0 失败**（新增 8 项 TTS 缓存回归 + 3 项文章分段） |
| Kotlin 括号 / 字符串模板感知扫描 | Python 词法配平 | ✅ 两文件 depth 0 |
| 空白错误 | `git diff --check` | ✅ 无错误 |
| Android 本地编译 / 真机 | `gradle / java / kotlinc` | ❌ 三个命令均不存在，未执行 |
| 云端工作流状态 | GitHub Actions REST（api.github.com） | ❌ SNI 级拦截，API 不可达，无法即时回收运行状态 |

**发布检查清单**：① `Android Formal Client` 编译通过并上传**正式用户 APK**（不是 `android-audio-prototype` 工作流产物）；② CI（`ci.yml`，含新增 `tts-cache.test.ts`）全绿；③ 真机播放矩阵（首播 / 重播零网络 / 慢速不双重降速 / 退后台 / 快速连点 / 切题过期回调 / 断网 / 404 / 额度不足 / 无效 token / MP3-WAV-M4A 解码）；④ 冷缓存并发与服务重启后供应商调用 = 0；⑤ 发布镜像绑定已验收 SHA/digest，而非 `latest`。

**回滚预案**：`git revert 05dd2c7`（服务端缓存/分段 + 客户端播放 + 契约 + CI 清单）可整体回退，不产生数据库 DDL / 迁移；服务端缓存索引位于 `.cache/audio/.tts-*.json`，属可重建缓存，删除不影响课程数据；Android 端为纯代码回退，无本地持久化数据结构变更。

---

## ✅ 行动清单

| # | 行动 | 负责方 | 紧急度 | 期望完成 |
|---|------|--------|--------|---------|
| 1 | 回收 `Android Formal Client` 工作流结果，确认 `assembleDebug` 编译通过；若失败，按编译日志修复 Kotlin 并复跑 | Android 客户端 | P0 | 本次推送后首个 CI 周期 |
| 2 | 以 `05dd2c7` 为真机联调基线，验证「再听一次」零网络、切页/退后台/快速连点不串音、下载结束才 settle | QA / 客户端 | P0 | 编译通过后 |
| 3 | 独立排期修复既有安全债：私人录音下载资产 ACL（公共课程 / 私人上传分区 + owner + 短 TTL）、租约服务端原子 claim 与实际用量自动结算 | 后端平台 | P1 | 下个安全迭代 |
| 4 | 给 `publish-docker.yml` 增加 `needs: [CI]` 并绑定已验收 SHA/digest，修正 CI 红仍推 `latest` 的发布门禁 | 发布负责人 | P1 | 下个发布迭代 |
| 5 | 补多实例分布式锁 / 对象存储 TTL 与容量清理，并让 M1 集成测试覆盖真实 start/turn 预热后供应商调用 = 0 | 后端平台 | P2 | 上线前 |

---

## ⚠️ 待完善 / 已知局限

- **Android 编译未经本地验证**：本机 `java / gradle / kotlinc / adb` 均不存在，仓库无 Gradle Wrapper；静态检查与 TypeScript 测试不能替代 Kotlin 编译与真机播放。
- **GitHub Actions 状态未能即时确认**：`api.github.com` 的 HTTPS 在本机被 SNI 级拦截，`gh` 也未安装，只能确认 SSH 推送成功与工作流触发条件匹配，不能宣称构建已绿。
- **专家团额度中断**：`gstack-product-reviewer`、`gstack-qa-lead`、`gstack-investigator`、`gstack-security-officer` 在部分运行中出现 `403 预扣额度失败`；产品评审员的完整四部分报告与最终独立终验未产出，本报告只汇编成员实际返回的内容，未代写、未视为完成。
- **既有安全债未随本次修复**：媒体下载无资产归属校验、租约可重放/零结算，安全官已给出离线复现与缓解方案，但需独立任务与授权，本轮未改动数据库、未做生产部署、未执行 seed。
- **缓存 scope 未做课程发布态绑定**：当前按「文本 + 音色参数」结构化键全局复用，未区分已发布课程与临时文本；动态/私人内容的租户隔离、最短保留与自动清理需在对象存储阶段补齐。
- **额度估算为启发式**：Android 按文本长度估算所需秒数（避免固定 120 秒误拒低额度账户），超长文章仍受服务端 120 秒单次计量上限约束；`mock://` 协议在 mock 网关下不可播放，正式 live 网关落盘 `/api/v1/media/audio/` 引用才可用。
- **`publish-docker.yml` 会随本次 main push 自动推 GHCR 镜像**：这是 GitHub Actions 的既有行为（推送镜像不等于生产部署或数据库迁移），本轮未进行任何服务器部署、数据库写入或 seed 操作。

---

## 📚 成员产出索引

- `gstack-product-reviewer`（产品评审员）：关键结论「orchestrator 把 teacherUtterance + demonstrationText 拼成一次 TTS，单独预热固定词不会命中」；完整报告因 403 未产出。
- `gstack-investigator`（排障/实现）：`TeacherSpeechController.kt` 初稿 + 三项编译阻断清单；后续额度中断，整合由主理人完成。
- `gstack-security-officer`（安全官）：完整只读安全审计（5 项分级发现 + 离线验证 + 最小可落地边界），明确未写入任何代码/测试/DB/配置。
- `gstack-qa-lead`（QA/发布）：完整只读核查（现有测试覆盖、本地验证清单、Actions 准确名称、7 项风险与 P0/P1/P2 优先级），未应用修复、未触发工作流。
- 主理人收口：服务端缓存加固、编排器分段、契约 `speech.segments`、Android 播放整合、静态守卫更新、195 项单元测试、`git` 提交与 SSH 推送。

---

> 本报告由软件工坊 AI 协作生成，关键决策请由工程负责人复核。
