# 教材词表 → 完整课程 / CEFR 预置课程

> 更新时间：2026-11-12  
> 目标：学校教材只需输入课本单词表，服务端自动补全词汇、句型、逐词活动、评估规则和媒体需求；CEFR 全量课程以纯 JSON 预置；图片与语音只在学习者到达对应级别后预热。

## 1. 内容分层

| 层 | 位置 | 是否含媒体 | 说明 |
|---|---|---|---|
| 纯 JSON 课程 | `packages/curriculum/data/cefr-curriculum.json` | 否 | 7 个等级、63 个单元、1197 个活动；含核心词汇、拓展词汇与日常用语/场景单元 |
| 生成器 | `packages/curriculum/src/cefr.ts` | 否 | 纯函数；不访问数据库、不调用模型，输入词表即可生成稳定结构 |
| 后端生成服务 | `services/backend/src/curriculum/curriculum-generator.service.ts` | 否 | 可选 AI 润色音标/释义/例句；失败保留确定性结构；可写入草稿库 |
| 媒体预热 | `services/backend/src/curriculum/curriculum-warmup.service.ts` | 是 | 到达级别后解析图片、写入 `media_assets`，再按发布内容预生成 `PUBLIC_CURRICULUM` TTS |

媒体不进入 JSON 的理由：

1. 图片 URL 可能过期、授权会变化，不能把外部 URL 当成课程内容冻结；
2. 一次生成全部级别的 TTS 会产生不可控费用，而且大部分级别短期用不到；
3. 语音缓存键依赖发布后的 `learning_items.content` 与 `contentVersion`，必须在发布/图片回填之后再生成。

## 2. JSON schemaVersion 2

入口契约：`packages/shared-contracts/src/curriculum.ts`。

```json
{
  "schemaVersion": 2,
  "packageId": "cefr-preset-v2",
  "title": "CEFR 儿童英语长期课程（预置）",
  "source": "preset",
  "generatedAt": "2026-11-12T00:00:00.000Z",
  "levels": [
    {
      "code": "pre-A1",
      "nameZh": "语感启蒙",
      "canDo": ["听懂高频问候和指令", "能模仿单词和短句"],
      "units": [
        {
          "code": "prea1-u01",
          "title": "语感启蒙 · 第 1 单元",
          "order": 0,
          "objectives": ["能听懂并说出 hello、hi、bye 等 5 个词"],
          "vocabulary": [
            {
              "word": "hello",
              "phonetic": "/həˈloʊ/",
              "meaningZh": "你好",
              "syllables": ["hel", "lo"],
              "difficultPhonemes": [],
              "phrases": ["hello", "Hello! I am Anna."],
              "exampleSentences": [{ "en": "Hello! I am Anna.", "zh": "你好！我是安娜。" }],
              "image": {
                "key": "img:prea1-u01:hello",
                "kind": "word",
                "targetWord": "hello",
                "targetText": "hello",
                "query": "hello children flashcard illustration",
                "alt": "hello 的儿童教学图片"
              }
            }
          ],
          "patterns": [{ "en": "This is a name.", "zh": "这是一个名字。" }],
          "lessons": [
            {
              "id": "prea1-u01:0",
              "title": "听一听：hello",
              "taskType": "listening_comprehension",
              "scenario": "greeting_scene",
              "skillNodeIds": ["LA.LISTEN.word_recognition"],
              "targetWords": ["hello"],
              "teacherUtteranceZh": "听一听，选出你听到的词：hello。",
              "demonstrationText": "hello",
              "requiresPronunciationAssessment": false,
              "requiresAsr": false,
              "assessment": {
                "acceptedImageIds": [],
                "acceptedTexts": ["hello"],
                "requiredPhrases": [],
                "openResponse": false
              },
              "difficulty": 1,
              "imageRequirements": [
                {
                  "key": "img:prea1-u01:hello",
                  "kind": "word",
                  "targetWord": "hello",
                  "targetText": "hello",
                  "query": "hello children flashcard illustration",
                  "alt": "hello 的儿童教学图片"
                }
              ],
              "media": {
                "speechKey": "prea1-u01:0",
                "speechText": "听一听，选出你听到的词：hello。 hello",
                "imageKeys": ["img:prea1-u01:hello"]
              }
            }
          ]
        }
      ]
    }
  ]
}
```

约束：

- `speechText` 是 `teacherUtteranceZh + demonstrationText` 的整轮合成文本，必须同时 ≤150 汉字/全角字符、≤500 字符；
- `skillNodeIds` 使用能力图谱稳定编码，发布时按 code 解析为数据库 ID；
- `assessment` 必须有可验证答案；`listening_comprehension` 等纯听读活动也必须能由既有规则判断；
- `media.imageKeys` 只指向图片需求，不携带 URL；
- `image.query` 是给图片搜索/生成服务的英文查询词，管理员可随时替换。

## 3. 教材词表生成

### 3.1 管理端入口

`/curriculum` 页面顶部「教材词表一键补全」：

1. 输入课程标题与目标等级；
2. 粘贴课本单词表（每行一个，或逗号分隔）；
3. 点击「生成完整课程 JSON」；
4. 服务端生成完整 JSON，并默认把每个单元写入 `curriculum_drafts`（状态 `generated`）；自动校验通过后直接发布（草稿 `published`、单元 `availability=active`），不再等待人工审核；
5. 点击「下载当前 JSON」保存纯 JSON 文件。

### 3.2 API

`POST /api/v1/admin/curriculum/textbook/generate`

请求：

```json
{
  "title": "三年级上册 Unit 3",
  "level": "A1",
  "words": "apple\nbanana\norange",
  "unitSize": 6,
  "useAi": true,
  "persist": true
}
```

`words` 可以是字符串或字符串数组；字符串支持换行、逗号、中文逗号、分号。`persist=false` 时只返回 JSON，不写草稿。

响应：

```json
{
  "packageId": "textbook-...",
  "title": "三年级上册 Unit 3",
  "levels": [{ "code": "A1", "units": 1, "lessons": 11 }],
  "draftCount": 1,
  "skipped": 0,
  "drafts": [{ "id": "...", "title": "基础生存 · 第 1 单元", "level": "A1", "unitCode": "a1-u01" }],
  "aiEnriched": true,
  "package": { "schemaVersion": 2, "..." : "完整 JSON" }
}
```

AI 润色：

- 词数 ≤80 时调用一次 `llm.learning_plan` 的小模型，补齐音标、中文释义、音节、发音难点、短语和例句；
- 输出必须是合法 JSON；字段缺失保留确定性内容；模型失败不阻断课程生成；
- AI 只改语言素材，不决定掌握判定、不把“已掌握”写进内容。

## 4. CEFR 预置课程

### 4.1 查看纯 JSON

`GET /api/v1/admin/curriculum/preset?level=A1`

- 省略 `level` 返回 7 个等级完整内容；
- 只读，不触库、不调用模型、不下载图片、不合成语音；
- 同一份内容也可由 `npm run generate:preset --workspace @alg/curriculum` 重新生成到 `packages/curriculum/data/cefr-curriculum.json`。

### 4.2 导入生成草稿

`POST /api/v1/admin/curriculum/preset/import`

```json
{ "level": "A1" }
```

- 每个单元创建一个 `curriculum_drafts`，状态 `generated`；
- 自动校验通过后可直接发布，不再要求人工 `under_review` / `approved`；
- `topicId` 稳定为 `preset:cefr-preset-v2:<level>:<unitCode>`，重复导入会跳过；
- 发布后管理员可随时编辑、下架、回滚。

## 5. 到达级别后的媒体预热

### 5.1 自动触发

`GET /api/v1/user/dashboard` 计算出 `avatarLevel.level` 后调用：

```ts
this.warmup.warmLearnerLevel(learner.id, avatarLevel.level);
```

- fire-and-forget，不阻塞仪表盘；
- 同一学习者同一级别 7 天内只触发一次（进程内存去重，重启后允许重新检查）；
- 环境变量 `CURRICULUM_WARMUP_ENABLED=false` 可关闭自动触发。

### 5.2 手动触发

`POST /api/v1/admin/curriculum/preset/warmup`

```json
{ "level": "A1", "maxImages": 24, "maxSpeech": 30, "maxAudioClips": 120 }
```

### 5.3 执行顺序

1. 查该级别 `curriculum_units.reviewStatus=published`；
2. 查对应 `learning_items`（`itemType=curriculum_activity`）；
3. 从 `imageRequirements` 提取真实用到的单词图、短句图、场景图；旧内容没有该字段时回退到 `targetWords`；已有 `imageAssets` 按 `key` 或 `targetText` 复用；
4. 缺失图片同时搜索 **Openverse** 与 **Wikimedia Commons**（免密钥；`CURRICULUM_IMAGE_SEARCH_URL` 可替换 Openverse 端点），按标题/标签与目标文本匹配度、分辨率、横竖版和插画关键词排序；
5. 只尝试授权明确、HTTPS、非 SVG 的候选；逐个创建 `media_assets` 并调用 `ImageCacheService.cacheNext`，失败自动换下一候选；
6. 把成功或已排队的 `imageAssets` / `imageAssetIds` 回填到 `learning_items.content`；
7. 剩余确实找不到的图片进入 `missingImages` 清单，管理端可导出 JSON 并逐张上传；
8. 从数据库重新读取最终 JSON，计算 `sha256(JSON.stringify(content))`；
9. 为每个有教材课文内容的单元预热逐句 `normal(1.0)` / `slow(0.65)` 与重点词拆读片段（见第 10 节），`maxAudioClips` 控制本次条数；
10. 用固定课程音色档（`gentle / 1000ms / slow_clear / 0.65`）和 `PUBLIC_CURRICULUM` scope 为活动旁白调用 `gateway.ttsWithResult`；
11. 返回图片下载/排队/挂载、缺失清单、逐句/拆读音频与活动旁白语音的成功/复用/跳过/失败计数。

### 5.4 mock 保护

`AI_GATEWAY_MODE=mock` 时只处理图片，跳过活动旁白与课程逐句/拆读音频，并返回：

```json
{ "mode": "mock-skip", "reason": "当前 AI_GATEWAY_MODE=mock，已跳过语音预生成，避免把占位音频写入正式缓存。" }
```

原因：mock 生成的音频会进入正式 `media_assets` 缓存，切 live 后可能被真实课堂命中。管理端在 mock 下点击重建也不会把原有 ready 片段删除（见 10.4）。

### 5.5 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `CURRICULUM_WARMUP_ENABLED` | 未设置（启用） | `false` 关闭仪表盘自动触发、单元异步预热与课程音频合成 |
| `CURRICULUM_IMAGE_SEARCH` | 未设置（启用） | `disabled` 关闭图片搜索，只保留已有图片 |
| `CURRICULUM_IMAGE_SEARCH_URL` | `https://api.openverse.org/v1/images/` | Openverse 兼容的图片搜索端点 |
| `CURRICULUM_IMAGE_COMMONS` | 未设置（启用） | `disabled` 关闭 Wikimedia Commons 备用来源 |
| `AI_GATEWAY_MODE` | — | `mock` 时跳过语音与课程音频预热 |

### 5.6 缺失清单与管理员上传

预热接口返回：

```json
{
  "imagesResolved": 18,
  "imagesQueued": 2,
  "missingImages": [
    {
      "key": "img:prea1-u01:hello",
      "kind": "word",
      "targetText": "hello",
      "query": "hello children flashcard illustration",
      "reason": "未搜索到授权明确的图片"
    }
  ]
}
```

管理端「课程管理」页会显示缺失清单，可导出 JSON，并为每条上传 JPEG/PNG/WebP/GIF：

`POST /api/v1/admin/curriculum/images/upload`（multipart）

| 字段 | 必填 | 含义 |
|---|---|---|
| `file` | 是 | 图片文件，最大 8MB |
| `key` | 是 | 缺失清单中的 `imageKey` |
| `kind` | 是 | `word` / `phrase` / `scene` |
| `targetText` | 是 | 目标词、短句或场景描述 |
| `targetWord` | 否 | 单词配图的目标词 |
| `license` | 否 | 默认 `admin-uploaded` |
| `attribution` | 否 | 来源说明 |

上传后服务端会写入 `media_assets`，按 `key` 挂到所有已发布活动，并返回挂载数量。图片变更会改变 `contentVersion`，已生成的语音需要重新预热才会命中。

## 6. 自动校验与发布

生成/导入只写草稿，不改变孩子掌握状态。P1-06 之后，自动校验是唯一的发布硬门：校验通过直接启用，不再要求人工提交 `under_review` 或审核 `approved`。

### 6.1 九类自动校验规则

校验器位于 `services/backend/src/curriculum/textbook-unit-qc.ts`，对完整的 `textbookUnitContent` 执行下列九类检查。错误（`error`）阻止启用；警告（`warning`）只进入质检报告，不阻塞文本启用。

| # | 类别 | 检查内容 | 典型错误码 |
|---|---|---|---|
| 1 | 结构与必填字段 | `textbookUnitContentSchema`：`resourceType`、教材/单元信息、目标、段落、活动等字段完整且类型正确 | `schema_invalid` |
| 2 | 句子与译文 | 句子 ID 唯一；`en` 非空；`zh` 非空、非占位文本、不含纯英文/以英文为主；中文不得与英文相同 | `sentence_id_duplicate`、`sentence_en_empty`、`sentence_zh_empty`、`sentence_zh_placeholder`、`sentence_zh_not_chinese` |
| 3 | 词条与媒体 | 词条不重复；中文释义 100%；音标覆盖率 ≥98%；音标格式异常只告警；图片必须有 HTTPS URL 与 license | `vocabulary_*`、`meaning_coverage_low`、`phonetic_coverage_low`、`image_url_not_https`、`image_license_missing` |
| 4 | 活动与评估 | 活动 ID 唯一；教师话语 ≤500 字符且 ≤150 汉字/全角；至少 1 个能力节点且节点存在；`evidenceKind` 合法；有可判定评估或显式 `passiveReading=true`；至少 1 个课文活动 | `activity_*`、`passage_activity_missing` |
| 5 | 语法点 | 语法点 ID 唯一；每个点至少 1 个例句；`sentenceIds` 只能引用存在的句子；录入 `grammarFocus` 时必须有语法点 | `grammar_*`、`grammar_point_missing` |
| 6 | 学校轨 | 声明学校轨时必须有模块和活动；活动必须有 `schoolModule`，模块必须在 `schoolTrack.modules` 中声明且至少有一个活动；建议绑定 `SE.*` 节点（缺失只告警） | `school_*` |
| 7 | IPA 与音素库存 | 将词条 IPA 与 `phoneme_items` 对照；库存未收录的符号只告警，避免因音素库不全误拦 | `ipa_symbol_unknown` |
| 8 | 儿童敏感内容 | 对课文、目标、词条、语法和活动执行确定性儿童不宜词表过滤；命中即拒绝启用，后续可替换为外部内容安全能力 | `sensitive_content` |
| 9 | 生成阶段问题 | 保留生成阶段 `qcReport.issues` 为警告，确保模型降级、占位译文等问题不会被静默丢弃 | `generation_*` |

校验结果包含 `ok`、`errors`、`warnings`、`issues`、`stats` 和 `checks`；`checks` 按句子、译文、音标、释义、活动、语法、学校轨、敏感内容等维度记录 `pass`/`warn`/`fail`。

### 6.2 active 状态机

```text
录入 / 生成
   │
   ├─ 自动校验通过 ──> active
   │                   reviewStatus=published
   │                   availability=active
   │                   curriculum_units + learning_items + vocabulary_items + version
   │
   └─ 自动校验失败 ──> 400 + issues
                       仅保存 metadata.content / qcReport
                       不创建 active unit、学习项、词卡或发布版本

active ──管理员 disable──> disabled（学习项/词卡同步 disabled，Planner 不再下发）
disabled ──管理员 enable──> active（恢复学习项/词卡）
active / disabled ──编辑──> 原 availability 不变，version+1
active / disabled ──回滚──> 原 availability 不变，version+1（目标版本重新校验）
```

- `reviewStatus='published'` 表示内容已通过自动校验并上线，不等于“人工审核通过”。
- 不再使用 `under_review` / `approved`；“待审核”不是管理端阻塞状态。
- 校验警告只写 `needsReview=true`，用于提示运营抽检；不阻止 `active`。
- 图片和语音可在级别预热阶段补齐，不阻塞文本启用。

### 6.3 400 `issues` 契约

生成失败时接口返回 HTTP 400，正文保留可定位的 JSON 路径：

```json
{
  "message": "自动校验未通过，课时未启用",
  "unitId": "33333333-3333-4333-8333-333333333333",
  "unitCode": "Unit 3",
  "issues": [
    {
      "code": "sentence_zh_empty",
      "path": "passage.paragraphs.0.sentences.2.zh",
      "message": "句子 Unit-3-s03 缺少中文译文。"
    }
  ],
  "warnings": [],
  "qcReport": {
    "checkedAt": "2026-11-18T10:00:00.000Z",
    "validation": { "ok": false, "errors": [], "warnings": [] }
  }
}
```

- `issues` 只包含阻断项；`warnings` 为非阻断项；两者都带 `code`、`path`、`message`，`path` 可直接定位到句子、词条或活动。
- 失败时生成内容仍写入教材单元 `metadata.content` 与 `metadata.qcReport`，方便管理员修正后重试；但不会产生线上 `curriculum_units`。
- 已上线内容编辑失败返回同样的 `issues` 结构，消息为“自动校验未通过，课时未更新”；回滚失败消息为“自动校验未通过，未回滚”。

### 6.4 编辑、回滚与下架

- `PUT /api/v1/admin/curriculum/units/:unitId/content`：教材单元请求体为完整 `textbookUnitContent` + `expectedVersion`；`expectedVersion` 等于 `curriculum_units.currentVersion`。
- 编辑事务依次写入新版本快照、更新 `curriculum_units`、同步 `learning_items` / `vocabulary_items`、更新教材 `metadata.content` 与 `qcReport`、写审计；任一步失败整体回滚。
- 乐观锁冲突返回 HTTP 409；编辑不改变当前 `availability`，下架单元编辑后仍保持下架。
- `POST /api/v1/admin/curriculum/units/:unitId/rollback`：复制历史快照为新版本并重新校验；目标版本损坏时拒绝回滚，当前版本保持不变。
- `POST /units/:unitId/disable` / `enable`：切换 `availability`，同步学习项和词卡状态，并写审计。

### 6.5 管理端定位与并发编辑

- `/curriculum` 页面的 `TextbookUnitPanel` 读取 `GET /textbook/units` 与 `GET /textbook/units/:unitId`；列表/详情新增 `publishedUnitId`、`currentVersion`、`contentVersion`、`availability`、`reviewStatus`、`qcReport`。
- 400 的 `issues[].path` 在前端按行解析：`passage.paragraphs.<p>.sentences.<s>.*` 定位句子行，`vocabulary.<i>.*` 定位词条行，`activities.<i>.*` / `schoolTrack.activities.<i>.*` 定位活动行；命中行标红并滚动到第一个阻断项。
- 仅当单元已有 `publishedUnitId` 且 `currentVersion` 非空时走 `PUT /units/:unitId/content`，请求体带 `expectedVersion`；否则只保存资源包到教材单元，等待重新生成/启用。

> 2026-11-17 起，原“人工审核后发布”规则已取消（`DECISIONS.md` D-022 / D-027 修订）。审核队列不再是发布门禁，但自动校验、专项核对、上线后抽检与审计仍必须保留。

## 7. ECDICT 词族词库

词库按词族保存，目标 5,000 族，其中核心 3,000 族；教材词表始终优先，ECDICT 只补空缺字段。

```bash
# 从仓库根目录的 ecdict.csv 重新生成 JSON（MIT）
npm run lexicon:build
# 先校验 JSON，不写数据库
npm run lexicon:import:dry
# 写入 lexicon_entries；教材单元 metadata 中的词会标记 textbookUnitIds
npm run lexicon:import
# 只导入全局词库，不扫描教材
npm run lexicon:import:global
```

当前构建结果：扫描 770,611 行，候选 56,992 词族，保留 5,000 族；核心 3,000 族中 2,992 个有音标、3,000 个有中文释义。

优先级从高到低：

1. 教材单元 `metadata.vocabulary` / 生成请求的输入词表（教材来源，保留教材字段）；
2. `lexicon_entries` 中 `textbookUnitIds` 非空的词族；
3. 全局 ECDICT 词族，仅填补空音标、空释义、空词性、空搭配/例句。

查询与运维接口：

- `GET /api/v1/admin/curriculum/lexicon/lookup?word=cat&textbookUnitId=...`；
- `GET /api/v1/admin/curriculum/lexicon/stats`；
- `GET /api/v1/admin/curriculum/textbook/units/:unitId/lexicon-coverage`；
- `POST /api/v1/admin/curriculum/units/:unitId/rollback`，body `{ "version": 1, "reason": "..." }`；
- `POST /api/v1/admin/curriculum/units/:unitId/disable`；
- `POST /api/v1/admin/curriculum/units/:unitId/enable`。

### 7.1 教材单元词库覆盖率（P1-10）

`/curriculum` 的教材单元面板会调用 `textbook/units/:unitId/lexicon-coverage` 展示覆盖率卡片。统计口径固定如下：

1. **词表来源**：合并 `metadata.words`、`wordList`、`vocabulary`、`keyWords` 与已生成内容 `metadata.content.vocabulary`；统一小写、去掉 `1.` 这类序号并去重。
2. **命中**：词表词条按 `lexicon_entries.word` 或 `variants` 找到词族才算命中；教材 metadata 自带的音标/释义不算词库命中。
3. **新词**：已命中，且同一教材更早 `order` 的单元没有出现过该词族。
4. **复用**：已命中，且同一教材更早 `order` 的单元已经出现过该词族；响应会带上 `priorUnitCodes`，卡片悬浮可见来源单元。
5. **缺口**：未命中 `lexicon_entries` 的词，进入待补词清单。

响应同时返回 `hitRate`（covered / total）、`newWords`、`reusedWords`、`gaps`、命中词条的音标/中文释义字段覆盖、`coreWords` / `coreRate` 以及 `method.priorUnitCount`。当前复用范围只覆盖**同教材更早单元**；跨教材、按阶段/主题的汇总留待后续扩展。

管理端在教材版本选择器下方提供**整册只读汇总**：先取该教材版本的全部单元（最多 200 个），逐单元调用上面的 `lexicon-coverage`，再按词去重汇总。同一词在多个单元出现只计一次；任一单元命中即算已覆盖，只有所有单元都未命中才进入“整册缺口词清单”。缺口词悬浮可看出现过的单元编码。该汇总不新增后端接口、不写入词库，也不提供一键入库。

停用会把单元 `availability` 置为 `disabled`，同时停用该单元的 `learning_items` / `vocabulary_items`；Planner 不会回落到内置活动，因此下架内容不会继续下发。

## 8. 教材单元映射（P1-08 / P3-04）

教材映射把“这个单元练什么”从生成器里的硬编码规则中拆出来，供课文资源生成与管理端维护。存储表为 `textbook_unit_mappings`，按 `(textbookId, unitCode)` 唯一；面向学习者的 `textbook_mappings` 仍保留当前教材/单元与能力节点，两者用途不同。

字段：

| 字段 | 说明 |
|---|---|
| `skillNodeIds` | 本单元映射到的能力节点；必须是能力图谱中真实存在的节点。 |
| `domains` | 主题领域，供检索与后续编排使用。 |
| `schoolModules` | 学校英语 A–E 模块；有模块时生成对应学校轨活动。 |
| `stageHint` | 建议阶段 0–6，仅作内容提示，不是解锁条件。 |
| `source` | `editorial` / `ai` / `inferred`。 |
| `version` | 每次保存递增，便于审计与追踪生成来源。 |

接口：

- `GET /api/v1/admin/curriculum/textbook/units/:unitId/mapping`：返回 `stored`（已保存配置，可为 `null`）、`effective`（当前生效配置）和 `skillNodeOptions`。
- `PUT /api/v1/admin/curriculum/textbook/units/:unitId/mapping`：保存或覆盖；未知能力节点返回 400。
- `DELETE /api/v1/admin/curriculum/textbook/units/:unitId/mapping`：删除显式配置，回退到自动推断。

没有显式配置时，`textbook-mapping.ts` 按单元标题/编码、教材标题、年级和 `grammarFocus` 做确定性推断，并标记 `source=inferred`。推断不会为了覆盖 A–E 而硬塞模块：没有学校轨线索时 `schoolModules` 为空。

生成器读取 `effective` 映射：

1. `stageHint` 优先使用显式映射，否则使用模型建议；
2. `schoolModules` 非空时，为每个模块生成至少一个可评估的学校轨活动（A 字母、B 拼读、C 阅读、D 拼写、E 句型/语法）；
3. 学校轨活动优先使用映射里的 `SE.*` 节点，再补模块默认节点；语言轨第一个课文活动也会带上映射里的 `LA.*` 节点；
4. 映射与生成来源写入 `qcReport.mapping`，不写掌握状态，不作为学生解锁门槛。

管理端在 `/curriculum` 的教材单元面板提供映射编辑：能力节点（带图谱选项提示）、主题领域、A–E 模块、建议阶段、来源；可保存、查看已保存版本、恢复自动推断。修改映射后需重新生成资源包才会反映到已启用内容。

> 未预置特定出版社的映射数据；出版社映射由管理员按授权教材维护，避免把地区教材硬编码进程序。

## 9. 七领域阶段画像（P3-01 / P3-03）

阶段画像把学习者能力按七个领域分开显示：听力、发音、词汇、语法、口语、交流、学校英语。它**不是**总等级，也不是课程访问门槛；某一条线低不会阻塞其他领域。

计算规则（`StageProfileService`）：

1. 只读 `skill_nodes`、`learner_skill_states`、`learning_evidence`，不写掌握状态。
2. 每个领域优先取 `masteryCode >= forming`（2）的最高 `growthStage`；
3. 没有形成中的节点时，才回退到 `encountered`（1）的最高阶段；
4. 两者都没有则为 0，不使用模型推断或默认抬高。
5. `stageNodeCounts` 返回当前展示阶段上的节点数，`evidenceCounts` 返回该领域累计证据条数；两者都用于解释，不参与晋级。

接口：

- `GET /api/v1/learners/:id/stages`：家长端，要求登录且只能读取当前账号名下的学习者。
- `GET /api/v1/admin/curriculum/learners/:learnerId/stages`：管理端，要求管理员会话。

返回示例：

```json
{
  "learnerId": "...",
  "stages": { "listening": 1, "pronunciation": 2, "vocabulary": 3, "grammar": 4, "speaking": 4, "communication": 5, "schoolEnglish": 4 },
  "stageNodeCounts": { "listening": 1, "pronunciation": 3, "vocabulary": 2, "grammar": 1, "speaking": 2, "communication": 2, "schoolEnglish": 2 },
  "evidenceCounts": { "listening": 0, "pronunciation": 0, "vocabulary": 0, "grammar": 0, "speaking": 0, "communication": 0, "schoolEnglish": 0 },
  "computedAt": "2026-11-18T09:23:59.428Z"
}
```

管理端 `/stages` 页面按学习者 ID 查询，显示七条独立阶段条；不自动列全部学习者，避免枚举儿童档案。家长端接口已提供，家长 Web 与 Android 的展示尚未接入。

## 10. 逐句双速、重点词拆读与课文下发（P2-01 ~ P2-04）

### 10.1 音频归属与版本失效

新增 `curriculum_audio_clips`，每条片段以以下六元组唯一：

```
unitId + contentVersion + clipKey + kind + partIndex + speedTier
```

- `clipKey`：句子为 `sentence:<sentenceId>`，重点词为 `word:<word>`；
- `kind`：`sentence | word | syllable | phoneme | blend | natural`；
- `speedTier`：`normal(1.0) | slow(0.65) | extra_slow(0.55)`；
- 编辑课程后 `contentVersion` 提升，新版本没有可匹配片段，旧音频不会误播；旧行保留，回滚后可直接复用；
- TTS 缓存作用域的 `contentId` 为 `<unitId>#<clipKey>`，因此缓存键实际包含课程身份、句子/词身份、版本与语速档，不按纯文本哈希跨课程复用（D-014 / D-1006）。

### 10.2 逐句双速预热（P2-01）

`CurriculumWarmupService.warmLevel()` 在图片回填后、整轮语音前调用 `CurriculumAudioService.warmUnit()`：

- 每句生成 `normal(1.0)` 与 `slow(0.65)` 两条；默认每单元最多 120 条片段，可用 `maxAudioClips` 收紧；
- 返回 `audioUnitsWarmed`、`sentenceClipsGenerated`、`wordClipsGenerated`、`audioClipsReused`、`audioClipsFailed`；
- 已 ready 且音频地址存在的片段直接复用，不重复计费；
- `AI_GATEWAY_MODE=mock` 或供应商返回 mock 时不写入正式缓存，只报告失败，等真实供应商可用后重建。

### 10.3 重点词拆读（P2-02）

`buildCurriculumAudioPlan()` 只做确定性规划，不调用模型：

1. 从课文复现次数、多音节、`difficultPhonemes`、句子 `keyWords` 打分，最多选 4 个重点词；
2. 没有词条信息的词只在数量不足时补位，不编造音标或释义；
3. 每个重点词按固定顺序生成：整词慢速 → 音节逐个 → 困难音素 → 音节合成 → 自然语速；
4. 单音节词不重复生成一份与整词相同的“音节”音频；
5. 音素优先与 `phoneme_items` 对照；音素表非空但未收录该符号时跳过并记录 `phoneme_not_in_inventory`。

### 10.4 重建接口（P2-03）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/v1/admin/curriculum/units/{unitId}/rebuild-audio` | 将当前版本 `ready/failed` 片段标记 `stale` 后强制重新请求 TTS；供应商缓存命中时计入 `reused`。body 可传 `{ "maxClips": 120 }` |
| `GET` | `/api/v1/admin/curriculum/units/{unitId}/audio` | 返回当前 `contentVersion` 的片段总数、按状态/类型统计 |

教材单元生成自动启用、已上线内容编辑成功后都会异步调用 `scheduleUnitAudio()`；失败只记日志，不阻断文本生效。`CURRICULUM_WARMUP_ENABLED=false` 或供应商为 mock 时，重建不会把原有 `ready` 片段留在 `stale`：没有新音频可替换时继续提供旧音频。

### 10.5 开课下发与证据类型（P2-04）

`POST /api/v1/lessons` 的响应新增可选 `passage`：

```json
{
  "unitId": "...",
  "topicId": "topic-textbook-...",
  "contentVersion": "...",
  "audioReady": true,
  "title": "My Family",
  "paragraphs": [{ "sentences": [{
    "id": "Unit-3-s01",
    "en": "This is my father.",
    "zh": "这是我的爸爸。",
    "keyWords": ["father"],
    "audio": {
      "normalKey": "sentence:Unit-3-s01:normal",
      "slowKey": "sentence:Unit-3-s01:slow",
      "normalRef": "/api/v1/media/audio/....mp3",
      "slowRef": "/api/v1/media/audio/....mp3",
      "normalSpeed": 1,
      "slowSpeed": 0.65
    }
  }] }],
  "focusWords": [{
    "word": "father",
    "phonetic": "/ˈfɑːðər/",
    "syllables": ["fa", "ther"],
    "difficultPhonemes": ["ð"],
    "clips": [{ "kind": "word", "speedTier": "slow", "speed": 0.65, "audioRef": "..." }]
  }]
}
```

- 文本始终下发；音频未 ready 时保留稳定 key、`audioRef=null`，客户端显示“正在准备”而不是伪造地址；
- 只有当前主题对应已发布且 `active` 的教材单元时才下发 `passage`；非教材单元为 `null`；
- `TeachingDirective` 新增 `evidenceKind`（默认 `none`）。显式声明优先；缺失时按任务类型保守推断：听选图→`listening_comprehension`，阅读→`reading_comprehension`，跟读/发音→`pronunciation`，句型/对话/自由表达→`production`，其余→`none`；
- 旧客户端忽略 `passage` 与 `evidenceKind`，仍按原活动播放示范文本，不会崩溃；Android 正式客户端（P2-05）已接入句子列表、正常/慢速点读、点句高亮、中文翻译开关与整篇连续播放，未下发 `passage` 时保持原课堂页。

### 10.6 本地验证

```powershell
cd services/backend
$env:DATABASE_URL='postgresql://postgres@127.0.0.1:15433/ai_language_growth?schema=public'
$env:P2_AUDIO_DB_INTEGRATION='1'
npx tsx --test test/curriculum-audio.integration.test.ts
```

集成测试会创建随机 `topicId` 的课程单元，验证双速/拆读写入、复用、重建、课文装配，结束后删除单元（音频片段级联删除）。

## 11. 已知边界

- Openverse 与 Wikimedia Commons 返回的是通用图片，可能不完全贴合教材语境；自动校验会标出缺失来源/授权，管理员可随时替换 `imageAssets`。
- 每个级别包含 5 个核心词汇单元、1 个拓展词汇单元和 3 个日常用语单元；日常用语覆盖问候、自我介绍、请求、购物、出行、就医、观点、协商等常见场景。
- 预置词库每级 25 个核心词 + 5 个拓展词、21 条日常用语，是长期课程骨架，不是完整词典；教材词表可按需扩展。
- `difficultPhonemes` 与音节切分是启发式结果，预置 JSON 已标注；自动校验应标红可疑项，管理员可随时修正。
- 媒体预热每次默认最多 24 张图、30 条活动旁白语音和 120 条课程逐句/拆读片段；大级别可分多次触发，已缓存资源不会重复计费。
- 预置课程导入后同样经自动校验直接发布；不会自动把 1197 个活动直接推给孩子，管理员可随时下架/回滚。
