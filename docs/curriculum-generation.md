# 教材词表 → 完整课程 / CEFR 预置课程

> 更新时间：2026-11-12  
> 目标：学校教材只需输入课本单词表，服务端自动补全词汇、句型、逐词活动、评估规则和媒体需求；CEFR 全量课程以纯 JSON 预置；图片与语音只在学习者到达对应级别后预热。

## 1. 内容分层

| 层 | 位置 | 是否含媒体 | 说明 |
|---|---|---|---|
| 纯 JSON 课程 | `packages/curriculum/data/cefr-curriculum.json` | 否 | 7 个等级、35 个单元、595 个活动；只含教学结构、词汇、例句、活动、评估规则和图片需求键 |
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
                "targetWord": "hello",
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
- `image.query` 是给图片搜索/生成服务的英文查询词，人工审核可替换。

## 3. 教材词表生成

### 3.1 管理端入口

`/curriculum` 页面顶部「教材词表一键补全」：

1. 输入课程标题与目标等级；
2. 粘贴课本单词表（每行一个，或逗号分隔）；
3. 点击「生成完整课程 JSON」；
4. 服务端生成完整 JSON，并默认把每个单元写入 `curriculum_drafts`（状态 `generated`），等待人工审核；
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

### 4.2 导入审核队列

`POST /api/v1/admin/curriculum/preset/import`

```json
{ "level": "A1" }
```

- 每个单元创建一个 `curriculum_drafts`，状态 `generated`；
- 不自动审核、不自动发布；
- `topicId` 稳定为 `preset:cefr-preset-v2:<level>:<unitCode>`，重复导入会跳过；
- 发布仍走既有 `draft -> submit -> approve -> publish` 流程。

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
{ "level": "A1", "maxImages": 24, "maxSpeech": 30 }
```

### 5.3 执行顺序

1. 查该级别 `curriculum_units.reviewStatus=published`；
2. 查对应 `learning_items`（`itemType=curriculum_activity`）；
3. 从 `targetWords` 提取真实用到的词；已有 `imageAssets` 直接复用；
4. 缺失图片调用 Openverse 搜索（`CURRICULUM_IMAGE_SEARCH_URL` 可替换），只选有明确 license 的结果；
5. 创建 `media_assets` 并调用 `ImageCacheService.cacheNext`；下载失败保留记录等待调度器重试；
6. 把 `imageAssets` / `imageAssetIds` 回填到 `learning_items.content`；
7. 从数据库重新读取最终 JSON，计算 `sha256(JSON.stringify(content))`；
8. 用固定课程音色档（`gentle / 1000ms / slow_clear / 0.65`）和 `PUBLIC_CURRICULUM` scope 调用 `gateway.ttsWithResult`；
9. 返回图片/语音成功、跳过、失败计数。

### 5.4 mock 保护

`AI_GATEWAY_MODE=mock` 时只处理图片，跳过语音，并返回：

```json
{ "mode": "mock-skip", "reason": "当前 AI_GATEWAY_MODE=mock，已跳过语音预生成，避免把占位音频写入正式缓存。" }
```

原因：mock 生成的音频会进入正式 `media_assets` 缓存，切 live 后可能被真实课堂命中。

### 5.5 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `CURRICULUM_WARMUP_ENABLED` | 未设置（启用） | `false` 关闭仪表盘自动触发 |
| `CURRICULUM_IMAGE_SEARCH` | 未设置（启用） | `disabled` 关闭图片搜索，只保留已有图片 |
| `CURRICULUM_IMAGE_SEARCH_URL` | `https://api.openverse.org/v1/images/` | Openverse 兼容的图片搜索端点 |
| `AI_GATEWAY_MODE` | — | `mock` 时跳过语音预热 |

## 6. 审核与发布

生成/导入只写草稿，不改变孩子掌握状态。发布链路仍由既有控制器负责：

- 人工提交 `under_review`；
- 人工审核 `approved`；
- 发布前校验每个活动有可验证评估规则、能力节点存在、整轮语音不超限；
- 发布后写入 `curriculum_units` + `learning_items`；
- 图片/语音在级别预热阶段补齐，不阻塞发布。

## 7. 已知边界

- Openverse 返回的是通用儿童闪卡图，可能不完全贴合教材语境；必须人工审核，必要时在后台替换 `imageAssets`。
- 预置词库每级 25 个核心词，是长期课程骨架，不是完整词典；教材词表可按需扩展。
- `difficultPhonemes` 与音节切分是启发式结果，预置 JSON 已标注；正式发布前应人工核对。
- 媒体预热每次默认最多 24 张图、30 条语音；大级别可分多次触发，已缓存资源不会重复计费。
- 预置课程导入后仍需人工审核；不会自动把 595 个活动直接推给孩子。
