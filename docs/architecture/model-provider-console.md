# 模型接入后台

管理后台位于 `apps/admin-web`，后端配置 API 为 `/api/v1/admin/model-providers`。普通 ASR 与发音评测是两条独立路由：ASR 只返回转写，发音评测要求目标文本并返回评测单元，禁止用转写结果替代发音评分。

## 启动配置

部署时设置 `ADMIN_CONFIG_TOKEN` 和 `MODEL_CONFIG_ENCRYPTION_KEY`。第二项必须为 32 字节的十六进制值；例如使用 `openssl rand -hex 32` 生成。模型密钥以 AES-256-GCM 加密后写入 `ai_provider_configs`。更换加密密钥会导致已有凭据无法解密。

Docker Compose 默认开放管理页面 `3001`、后端 API `3100`。页面从浏览器所在主机的 `3100` 端口连接后端；改变 API 外部端口或使用反向代理时，应设置 `NEXT_PUBLIC_BACKEND_URL` 为浏览器可访问的后端地址，并重新构建管理页面。运行数据库迁移后即可使用配置 API。

配置保存后会立即更新对应服务的运行时 adapter 和 Router 别名。各服务的 API 地址可在界面中覆盖；平台域名、区域或自建兼容端点变化时无需改业务代码。

## 预置服务和协议

| 平台 | LLM | TTS | 普通 ASR | 音素/发音评测 | 接入说明 |
| --- | --- | --- | --- | --- | --- |
| 阿里云百炼 | OpenAI 兼容 Chat | 百炼语音 HTTP | Qwen Audio ASR HTTP | — | 语音需要 Workspace ID、地域 API Key、模型和音色。 [TTS API](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api) · [ASR API](https://help.aliyun.com/zh/model-studio/qwen-audio-asr-http-api) |
| 火山引擎 | Ark Chat | TTS V3 HTTP Chunked/SSE | — | — | TTS 需要 API Key、Resource ID、模型和音色。 [TTS API](https://docs.volcengine.com/docs/doubao-voice/http-chunked-sse-unidirectional-streaming-v3?lang=zh) |
| 百度千帆 | OpenAI 兼容 Chat | 百度语音同步 TTS | 百度短语音 REST ASR | — | 后端用 API Key/Secret Key 换取语音 Token。 [TTS API](https://cloud.baidu.com/doc/SPEECH/s/xmw03avls) · [ASR API](https://cloud.baidu.com/doc/SPEECH/s/0lbxfnc9b) |
| 科大讯飞星火 | OpenAI 兼容 Chat | WebSocket TTS | WebSocket IAT | ISE 发音评测 | TTS/IAT 使用 AppID、API Key、API Secret；ISE 使用 AppID、API Key。 [TTS API](https://www.xfyun.cn/doc/tts/online_tts/API.html) · [ISE API](https://www.xfyun.cn/doc/voiceservice/ise/API.html) · [ISE 结果结构](https://www.xfyun.cn/doc/voiceservice/ise/ise_protocol.html) |
| MiniMax 稀宇科技 | OpenAI 兼容 Chat | T2A v2 HTTP | — | — | TTS 使用 MiniMax 原生请求体和 hex 音频响应，不套用 OpenAI Audio。 [对话 API](https://platform.minimaxi.com/document/对话) · [T2A v2](https://platform.minimaxi.com/document/T2A%20V2?key=66719005a427f0c8a5701643) |
| Ollama | OpenAI 兼容 Chat | — | — | — | 当前只开放 LLM。服务器必须能访问所配置的 Ollama 地址。 [API 兼容说明](https://docs.ollama.com/api/openai-compatibility) |
| OpenAI 兼容 | Chat Completions | Audio Speech | Audio Transcriptions | — | 可自定义 API 地址、模型与可选 Key；只有符合标准路径/格式的服务才可直接使用。 |
| 腾讯云智聆 SOE | — | — | — | SOE WebSocket 录音评测 | 配置 AppID、SecretID、SecretKey；使用目标文本和评测模式。 [SOE API](https://cloud.tencent.com/document/product/1774/107497) |
| Microsoft Azure Speech | — | — | — | Speech Recognition + Pronunciation Assessment | 配置资源密钥和区域或自定义 endpoint。 [评测说明](https://learn.microsoft.com/azure/ai-services/speech-service/how-to-pronunciation-assessment) · [短音频 REST API](https://learn.microsoft.com/azure/ai-services/speech-service/rest-speech-to-text-short) |
| Speechace | — | — | — | REST 文本朗读评分 | 使用 API Key、口音和区域 endpoint；支持单词/音节/音素评分、重音和自定义 ARPABET 标注。 [Score Text API](https://api-docs.speechace.com/api-reference/score-text.md) |
| 驰声英语评测（百度 AI 市场） | — | — | — | Function Calling REST 评测 | 独立的驰声 API Key；市场商品由驰声提供，不能复用千帆凭据。支持单词与句子评测及音素明细。 [驰声 API](https://api-account.cloud.chivox.com/zh/docs) |

未列出的能力不会在目录中展示为可选项。Ollama 的语音能力受本地模型、操作系统和 Ollama 版本影响，不能因为支持 OpenAI Chat API 就推断它兼容 TTS/ASR。

## ASR 与发音评测

- `asr` 接收音频并输出 transcript，可用于自由对话理解或跟读初筛。
- `pronunciation` 接收音频、目标文本、语言和评测粒度，输出总体分数及单词/音节/音素明细。
- Azure 直接返回音素级 `AccuracyScore`；腾讯 SOE 返回其逐音素结果；讯飞 ISE 的明细结构包含 word/syllable/phone 层级。平台的音频格式、时长、语言和音素格式要求不同，超出平台能力时应由各自调用报错，不做 ASR 结果伪装。
- Speechace 使用单独的订阅 API Key 和区域 endpoint，英文支持 `en-us` / `en-gb`；其 Score Text API 可返回单词、音节、音素及重音分数。驰声在百度 AI 市场的产品来自独立服务商，运行时使用驰声 API 而不是百度千帆鉴权。
- 阿里云智能科教内容生成平台（SSECP）的口语评测与 DashScope 模型 API 是不同产品。评测由 Android 端官方 SDK 采集音频并连接评测引擎；服务端只负责安全签发 `warrant_id`，Web 管理后台只管理 AppKey/AppSecret 和授权服务地址，不执行评测。Android 客户端接入应遵循[官方 Android SDK 文档](https://help.aliyun.com/zh/document_detail/2873524.html)；服务端签发流程见[授权接口文档](https://help.aliyun.com/zh/document_detail/2865622.html)。该 SDK 包需从 SSECP 控制台项目下载，尚未纳入 Android 工程。

腾讯与 Azure 适配器需 Node.js 20.10 或更高版本提供全局 WebSocket 能力。Azure REST 适配器面向平台短音频识别限制；长音频应在后续接入其连续评测协议。
