# 模型接入后台

管理后台位于 `apps/admin-web`，后端配置 API 为 `/api/v1/admin/model-providers`。普通 ASR 与发音评测是两条独立路由：ASR 只返回转写，发音评测要求目标文本并返回评测单元，禁止用转写结果替代发音评分。

## 启动配置

部署时在服务器 `.env` 设置 `ADMIN_USERNAME`、`ADMIN_PASSWORD` 与 `MODEL_CONFIG_ENCRYPTION_KEY`。加密密钥必须为 32 字节的十六进制值；例如使用 `openssl rand -hex 32` 生成。管理员登录后通过 HttpOnly 会话 Cookie 使用管理接口。模型密钥以 AES-256-GCM 加密后写入 `ai_provider_configs`。更换加密密钥会导致已有凭据无法解密。

Docker Compose 默认开放管理页面 `3001` 和用户 Web `3002`。数据库、Redis、后端 API 均只在 Compose 内网可见；两个 Next.js 页面通过同源 `/api/v1` rewrite 访问 `backend:3000`，浏览器不需要直接访问后端端口。真机和外部浏览器应使用 Web 的 HTTPS 入口，或临时访问 Web 的 `3002` 端口。

配置保存后会立即更新对应服务的运行时 adapter 和 Router 别名。各服务的 API 地址可在界面中覆盖；平台域名、区域或自建兼容端点变化时无需改业务代码。

SMTP 配置、备份目标和 WebDAV 凭据均在管理后台保存到数据库并加密敏感字段。数据库备份压缩包只包含 `database.dump`，不包含后端 `.cache/audio` 音频缓存；OpenList 仅作为百度网盘或阿里云盘的 WebDAV 适配入口。

## 预置服务和协议

| 平台 | LLM | TTS | 普通 ASR | 音素/发音评测 | 接入说明 |
| --- | --- | --- | --- | --- | --- |
| 阿里云百炼 | OpenAI 兼容 Chat | 百炼语音 HTTP | Qwen Audio ASR HTTP | — | 语音需要 Workspace ID、地域 API Key、模型和音色。 [TTS API](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api) · [ASR API](https://help.aliyun.com/zh/model-studio/qwen-audio-asr-http-api) |
| 火山引擎 | Ark Chat | TTS V3 HTTP Chunked/SSE | 录音识别 HTTP | — | TTS 需要 API Key、Resource ID、模型和音色；普通 ASR 使用录音识别资源 ID 与音频 Base64。 [TTS API](https://docs.volcengine.com/docs/doubao-voice/http-chunked-sse-unidirectional-streaming-v3?lang=zh) · [ASR API](https://docs.volcengine.com/docs/doubao-voice/recording-file-recognition-lite-http?lang=zh) |
| 百度千帆 | OpenAI 兼容 Chat | 百度语音同步 TTS | 百度短语音 REST ASR | — | 后端用 API Key/Secret Key 换取语音 Token。 [TTS API](https://cloud.baidu.com/doc/SPEECH/s/xmw03avls) · [ASR API](https://cloud.baidu.com/doc/SPEECH/s/0lbxfnc9b) |
| 科大讯飞星火 | OpenAI 兼容 Chat | WebSocket 超拟人 TTS | WebSocket 语音听写 V2 | SunTone/ISE 适配预置 | TTS/IAT 使用 AppID、API Key、API Secret；后台默认接入点分别为 `cbm01.cn-huabei-1.xf-yun.com/v1/private/mcd9m97e6` 和 `iat.cn-huabei-1.xf-yun.com/v1`，均可自定义。发音评测使用独立能力和账号，适配器须以当前账号协议和真实样本验收后启用。IAT 适配器要求 16kHz、16-bit、单声道 PCM WAV，最长 60 秒。 [超拟人 TTS API](https://www.xfyun.cn/doc/spark/super%20smart-tts.html) · [IAT API](https://www.xfyun.cn/doc/spark/spark_zh_iat_new.html) · [SunTone API](https://www.xfyun.cn/doc/voiceservice/suntone/API.html) |
| MiniMax 稀宇科技 | OpenAI 兼容 Chat | T2A v2 HTTP | — | — | TTS 使用 MiniMax 原生请求体和 hex 音频响应，不套用 OpenAI Audio。 [对话 API](https://platform.minimaxi.com/document/对话) · [T2A v2](https://platform.minimaxi.com/document/T2A%20V2?key=66719005a427f0c8a5701643) |
| Ollama | OpenAI 兼容 Chat | OpenAI Audio 兼容 Speech | OpenAI Audio 兼容 Transcriptions | — | 预置地址为 `http://localhost:11434/v1`。服务器端 Ollama 部署或兼容服务必须提供 `/audio/speech`、`/audio/transcriptions` 并安装支持对应任务的模型；语速固定为 1，音色由模型决定。服务器必须能访问所配置地址。该项是兼容协议预置，不代表任意 Ollama 安装都内置语音能力。 [Ollama OpenAI 兼容说明](https://docs.ollama.com/api/openai-compatibility) |
| 硅基流动 | OpenAI 兼容 Chat | OpenAI Audio Speech | OpenAI Audio Transcriptions | — | 同一 API Key 按对应服务权限使用，可按服务覆盖 API 地址。 [TTS](https://docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech) · [ASR](https://docs.siliconflow.cn/docs/api/audio-transcriptions-post) |
| 腾讯云语音服务 | — | TC3 签名 TTS | TC3 签名一句话识别 | — | 填写 Secret ID、Secret Key 和地域；语音服务凭据独立于腾讯混元。 [TTS](https://cloud.tencent.com/document/api/1073/37995) · [ASR](https://cloud.tencent.com/document/product/1093/134682) |
| 腾讯云混元 | OpenAI 兼容 Chat | — | — | — | 预置混元 OpenAI 兼容 endpoint，后台只需填写 API Key、模型和可覆盖的接入地址。 [混元文档](https://cloud.tencent.com/document/product/1729) |
| OpenAI 兼容 | Chat Completions | Audio Speech | Audio Transcriptions | — | 可自定义 API 地址、模型与可选 Key；只有符合标准路径/格式的服务才可直接使用。 |
| 腾讯云智聆 SOE | — | — | — | SOE WebSocket 录音评测 | 配置 AppID、SecretID、SecretKey；使用目标文本和评测模式。 [SOE API](https://cloud.tencent.com/document/product/1774/107497) |
| Microsoft Azure Speech | — | — | — | Speech Recognition + Pronunciation Assessment | 配置资源密钥和区域或自定义 endpoint。 [评测说明](https://learn.microsoft.com/azure/ai-services/speech-service/how-to-pronunciation-assessment) · [短音频 REST API](https://learn.microsoft.com/azure/ai-services/speech-service/rest-speech-to-text-short) |
| Speechace | — | — | — | REST 文本朗读评分 | 使用 API Key、口音和区域 endpoint；支持单词/音节/音素评分、重音和自定义 ARPABET 标注。 [Score Text API](https://api-docs.speechace.com/api-reference/score-text.md) |
| 驰声英语评测（百度 AI 市场） | — | — | — | Function Calling REST 评测 | 独立的驰声 API Key；市场商品由驰声提供，不能复用千帆凭据。支持单词与句子评测及音素明细。 [驰声 API](https://api-account.cloud.chivox.com/zh/docs) |

未列出的能力不会在目录中展示为可选项。Ollama 的语音能力取决于本地安装的语音模型或兼容扩展；预置项只负责按 OpenAI Audio 协议调用，不保证任意 Ollama 模型天然提供 TTS/ASR。

## ASR 与发音评测

- `asr` 接收音频并输出 transcript，可用于自由对话理解或跟读初筛。
- `pronunciation` 接收音频、目标文本、语言和评测粒度，输出总体分数及单词/音节/音素明细。
- Azure 直接返回音素级 `AccuracyScore`；腾讯 SOE 返回其逐音素结果；讯飞 ISE 的明细结构包含 word/syllable/phone 层级。平台的音频格式、时长、语言和音素格式要求不同，超出平台能力时应由各自调用报错，不做 ASR 结果伪装。
- Speechace 使用单独的订阅 API Key 和区域 endpoint，英文支持 `en-us` / `en-gb`；其 Score Text API 可返回单词、音节、音素及重音分数。驰声在百度 AI 市场的产品来自独立服务商，运行时使用驰声 API 而不是百度千帆鉴权。
- 阿里云 SSECP、腾讯 SOE、讯飞 SunTone/ISE、Azure 和 Speechace 均按服务端 API 适配器管理。当前不把它们的 SDK 固化进 Android；管理员可以为同一 `pronunciation` 类型配置多条记录，按优先级、超时和 Benchmark 自动主备切换。讯飞 ISE 旧协议与 SunTone 当前协议可能因账号产品不同而不同，正式启用前必须按控制台开通能力完成真实验收。

腾讯与 Azure 适配器需 Node.js 20.10 或更高版本提供全局 WebSocket 能力。Azure REST 适配器面向平台短音频识别限制；长音频应在后续接入其连续评测协议。
