# 教材词表 → 完整课程 / CEFR 预置课程

> 更新时间：2026-11-12  
> 目标：学校教材只需输入课本单词表，服务端自动补全词汇、句型、逐词活动、评估规则和媒体需求；CEFR 全量课程以纯 JSON 预置；图片与语音只在学习者到达对应级别后预热。

## 1. 内容分层

| 层 | 位置 | 是否含媒体 | 说明 |
|---|---|---|---|
| 纯 JSON 课程 | `packages/curriculum/data/cefr-curriculum.json` | 否 | 7 个等级、49 个单元、917 个活动；含核心词汇单元与日常用语/场景单元 |
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
3. 从 `imageRequirements` 提取真实用到的单词图、短句图、场景图；旧内容没有该字段时回退到 `targetWords`；已有 `imageAssets` 按 `key` 或 `targetText` 复用；
4. 缺失图片同时搜索 **Openverse** 与 **Wikimedia Commons**（免密钥；`CURRICULUM_IMAGE_SEARCH_URL` 可替换 Openverse 端点），按标题/标签与目标文本匹配度、分辨率、横竖版和插画关键词排序；
5. 只尝试授权明确、HTTPS、非 SVG 的候选；逐个创建 `media_assets` 并调用 `ImageCacheService.cacheNext`，失败自动换下一候选；
6. 把成功或已排队的 `imageAssets` / `imageAssetIds` 回填到 `learning_items.content`；
7. 剩余确实找不到的图片进入 `missingImages` 清单，管理端可导出 JSON 并逐张上传；
8. 从数据库重新读取最终 JSON，计算 `sha256(JSON.stringify(content))`；
9. 用固定课程音色档（`gentle / 1000ms / slow_clear / 0.65`）和 `PUBLIC_CURRICULUM` scope 调用 `gateway.ttsWithResult`；
10. 返回图片下载/排队/挂载、缺失清单和语音成功/跳过/失败计数。

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
| `CURRICULUM_IMAGE_COMMONS` | 未设置（启用） | `disabled` 关闭 Wikimedia Commons 备用来源 |
| `AI_GATEWAY_MODE` | — | `mock` 时跳过语音预热 |

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

## 6. 审核与发布

生成/导入只写草稿，不改变孩子掌握状态。发布链路仍由既有控制器负责：

- 人工提交 `under_review`；
- 人工审核 `approved`；
- 发布前校验每个活动有可验证评估规则、能力节点存在、整轮语音不超限；
- 发布后写入 `curriculum_units` + `learning_items`；
- 图片/语音在级别预热阶段补齐，不阻塞发布。

## 7. 已知边界

- Openverse 与 Wikimedia Commons 返回的是通用图片，可能不完全贴合教材语境；必须人工审核，必要时在后台替换 `imageAssets`。
- 每个级别包含 5 个核心词汇单元和 2 个日常用语单元；日常用语覆盖问候、自我介绍、请求、购物、出行、就医、观点、协商等常见场景。
- 预置词库每级 25 个核心词、14 条日常用语，是长期课程骨架，不是完整词典；教材词表可按需扩展。
- `difficultPhonemes` 与音节切分是启发式结果，预置 JSON 已标注；正式发布前应人工核对。
- 媒体预热每次默认最多 24 张图、30 条语音；大级别可分多次触发，已缓存资源不会重复计费。
- 预置课程导入后仍需人工审核；不会自动把 917 个活动直接推给孩子。
