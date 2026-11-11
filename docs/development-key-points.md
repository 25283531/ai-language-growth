# 开发要点：三个掌握判定问题与语音链路

> 对应任务书“教学数据必须有可靠证据”。本文件记录本轮修复的判定规则、容易回归的边界，以及代码落点。
> 相关测试：`packages/skill-graph/test/mastery.test.ts`、`services/backend/test/prosody-contract.test.ts`、`tts-scope.test.ts`、`tts-privacy.test.ts`、`prisma-usage-ledger.test.ts`。

## 1. 三个判定问题

### 1.1 “有提示”必须真实进入判定，不能只记在事件里

**问题**：编排层虽然生成了 `prompted` 语义，但调用 `assess` 时没有传；发音、ASR、点选、文本分支把“答对”一律当成独立样本。结果是：孩子听老师说完答案再重复，也会被算成独立掌握。

**修复**（`services/backend/src/orchestrator/orchestrator.service.ts`）：

```ts
const promptedAttempt = consecutiveFailures > 0 || current !== 'method_slow_clear';
```

- 之前已经失败过（进入纠错阶梯），或有任何提示/示范/慢速重说，都算 `prompted`。
- 各分支统一改为：

```ts
const independent = passed && !prompted;
```

- 证据仍记录 `prompted`，但只有 `independent` 样本能推进“独立场景数”。
- 规则：有提示的正确表现可以维持 `forming`，不能单独推到 `mastered/transferred`。

**回归点**：新增活动类型时，必须把 `prompted` 传进 `assess`；不能只在 `interaction_events` 里写字段。

### 1.2 R4：跨天回忆的 24 小时从“第 N 个场景成立”起算

**问题**：旧实现用“最早证据”或“当前时间减第一条证据”判断跨天，导致：

- 旧场景的证据可以替新场景补足 24 小时间隔；
- 第 N 个场景刚成立，就拿更早的时间戳通过 `transferred`。

**修复**（`packages/skill-graph/src/mastery.ts`）：

1. 先按场景去重，取每个场景**首次独立通过**的时间；
2. 按时间排序，取第 N 个不同场景的首次通过时间 `nthSceneAt`；
3. 只有 `now - nthSceneAt >= 24h`，且存在该时间之后的**无提示回忆**，才允许 `transferred`。

**含义**：

- 同一天在三个场景都答对，仍然是 `mastered`，不是 `transferred`。
- 第二天无提示回忆成功，才完成“跨天保持”。
- 旧证据不会因为“时间很久”自动变成跨天证据。

### 1.3 R6：只有“真实回归”才降级；恢复需要新证据

**问题**：旧实现只要最近一次失败，就可能把 `mastered` 降级；或者一次同场景成功就直接恢复，绕过了跨场景和跨天要求。

**修复**：

- 回归条件：失败必须发生在**首次达到 mastered 所需的独立样本之后**；更早的失败只是学习过程，不构成回归。
- 回归后：`mastered/transferred` 降为 `forming`（或规则定义的低档），不能继续保留。
- 恢复条件：重新满足“N 个不同场景的独立通过 + 跨天无提示回忆”，不能只靠同场景重复。
- 没有回归时：单场景的历史证据或一次失败，不得把 `mastered` 降级。

**回归点**：任何“简化掌握计算”的重构，必须保留三个输入：场景、独立/提示、时间；缺一不可。

## 2. 固定课程 TTS：首调用生成，跨用户复用

### 2.1 什么可以 PUBLIC

只有同时满足以下条件才进入 `PUBLIC_CURRICULUM`：

- 教师话语来自**已发布内容**（`teacherUtteranceFromPublishedContent`）；
- 不是本轮动态生成（`dynamicTeacherUtterance=false`）；
- 示范文本不是由本轮错误动态导出（`dynamicDemonstration=false`）。

复习轮、上一主题问候、根据孩子错误拼出的示范，一律 `PRIVATE_DYNAMIC`。

代码：`resolvePublicCurriculum()`（`orchestrator.service.ts`），测试：`tts-public-scope.test.ts`。

### 2.2 音色与语速

- PUBLIC 使用统一课程音色档：`gentle / 1000ms / slow_clear`，不携带某个孩子的人格语气。
- 语速量化到 0.05 档，避免浮点差异导致缓存击穿。
- PRIVATE 指纹包含 `learnerId`；PUBLIC 指纹忽略 `learnerId`。
- 课程键包含 `topicId/contentId/contentVersion/voiceParamsHash/modelFamily/textHash`；内容版本变化会让旧音频失效。

### 2.3 成本

- 账本单价统一为 **元/千字符**（`per_1000_chars`）。
- 历史 `per_character` 仍可读：有 `per_1000_chars` 时优先新价，否则回退旧价，二者不叠加。
- TTS 字符数按实际送合成文本计，不按 UTF-8 字节。

## 3. 录音不落盘

### 3.1 数据流

1. Android 录到应用本地缓存，保留路径供“回放我的录音”。
2. 提交回合时读取本地文件 → Base64，放入 `learnerResponse.audioBase64` + `audioContentType`。
3. 后端 `lessons.controller.ts` 在**本次请求内**转成 `data:` URI，交给 ASR/发音适配器。
4. 供应商返回结果后，`persistedLearnerResponse()` 在写 `interaction_events` 前剥除 `audioRef/audioBase64/audioContentType`，只保留 `audioProvided`。
5. `POST /media/audio/uploads` 返回 410 `AUDIO_UPLOAD_DISABLED`；服务端不再创建儿童录音文件。

### 3.2 隐私政策必须写清

- 录音文件保存在孩子手机本地，供回放；服务端不保留录音文件。
- 为完成当次语音识别/发音评估，音频会在请求内转发给配置的语音服务商；服务商是否留存由其政策决定，选型时必须确认“不用于训练/不长期保留”。
- 学习记录只保存识别文本、评分、错误单元和证据，不保存原始音频。

### 3.3 已知限制

- Base64 会让请求体增大约 33%；当前 JSON 上限 8MB，约够 1 分钟内的 AAC 录音。超长录音应提示分段，而不是放宽到无上限。
- 服务端仍会在内存中短暂持有音频；这不是“端侧完全不出设备”，而是“服务端不落盘”。
- 真机需要验证：录音格式、采样率、文件可读性、回放路径、进程被杀后的文件生命周期。

## 4. 发音结果交给文本模型

- `PronunciationCoachService` 只在“发音评估执行且未通过”时调用。
- 输入：目标词、分数、结构化 `errorUnits`（unit/kind/detail）。
- 输出：`focus/correction/encouragement`，拼成一句 ≤60 汉字的 `displayText`。
- 该句拼在下一轮 `teacherUtterance` 前面，走同一条 TTS 链路；因为教师话语变了，本轮强制 `PRIVATE_DYNAMIC`。
- 模型失败、超时、坏 JSON：回退确定性文案，不阻断课堂。
- 评分和掌握状态仍由规则引擎决定；文本模型只负责“怎么跟孩子说”，不负责“是否通过”。

## 5. 本地验证命令

```bash
npm run build --workspace @alg/shared-contracts
npm run typecheck --workspace @alg/backend

npx tsx --tsconfig services/backend/tsconfig.json --test \
  services/backend/test/prisma-usage-ledger.test.ts \
  services/backend/test/prosody-contract.test.ts \
  services/backend/test/tts-scope.test.ts \
  services/backend/test/tts-privacy.test.ts \
  services/backend/test/tts-public-scope.test.ts \
  packages/skill-graph/test/mastery.test.ts
```

Android 编译必须走 GitHub `android-client.yml`；本机没有 JDK/Gradle，不能把“源码改完”当成“Android 已验证”。
