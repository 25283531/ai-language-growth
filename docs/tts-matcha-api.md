# TTS 语音合成 API 说明（Matcha 引擎）

> 引擎：sherpa-onnx（纯 CPU）+ matcha-icefall-zh-en + vocos-16khz-univ 声码器
> 音色：单一中文女声，中英双语；采样率 16000 Hz，单声道
> 服务版本：2026-11-16 起（已由 Kokoro 切换为 Matcha，Kokoro / ZipVoice 已删除）

## 1. 服务地址

| 场景 | 地址 |
| --- | --- |
| 公网（推荐） | `https://tts.250886.xyz` |
| 机器本地 | `http://127.0.0.1:8890`（free-machine-1 本机） |

在线接口文档（Swagger）：`https://tts.250886.xyz/docs`

## 2. 鉴权

- 仅 `/tts` 接口需要口令；`/health`、`/voices`、`/docs` 免口令。
- 口令是部署时生成的一串十六进制字符串（找管理员/辉哥本人索取，本文不写明文）。
- 三种携带方式**任一对上即放行**：

| 方式 | 写法 |
| --- | --- |
| 请求头 | `X-API-Key: <口令>` |
| 请求头 | `Authorization: Bearer <口令>` |
| 查询参数 | `?token=<口令>`（仅浏览器试听时方便，程序调用请优先用请求头） |

- 口令缺失或错误：返回 `401 {"detail":"invalid or missing API token"}`。

## 3. 接口一览

| 方法 | 路径 | 说明 | 需口令 |
| --- | --- | --- | --- |
| GET | `/health` | 健康检查 + 当前模型信息 | 否 |
| GET | `/voices` | 音色列表（当前仅 1 个） | 否 |
| POST | `/tts` | 语音合成（JSON 请求体，功能最全） | 是 |
| GET | `/tts` | 语音合成（URL 参数版，方便浏览器/简单调用） | 是 |
| GET | `/` | 服务索引（JSON） | 否 |

## 4. POST /tts —— 合成（主接口）

请求头：`Content-Type: application/json`，外加口令（见第 2 节）。
响应：音频二进制流，`Content-Type` 为 `audio/wav` 或 `audio/mpeg`。

### 4.1 请求参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `text` | string | 是 | — | 待合成文本，中英文混排可。规范化后上限 800 字符，超限返回 400。服务端自动做中文标点规范化、按句切分逐句合成，句间插入 0.12 秒静音 |
| `speed` | number | 否 | `1.0` | 语速，范围 0.5–2.0，超出自动钳制。小于 1 变慢、大于 1 变快；自然度建议 0.9–1.1 |
| `format` | string | 否 | `wav` | 输出格式：`wav`（16-bit PCM）或 `mp3`（64 kbps），其余值返回 400 |
| `stream` | boolean | 否 | `false` | `true` 时按句边合成边返回（流式），首包延迟低，适合长文本/实时播放；WAV 流式的长度字段为占位值（0xFFFFFFFF），个别老播放器可能不认，存文件场景请用非流式 |
| `voice` | string | 否 | — | 兼容字段：当前只有 `matcha_zh_en` 一个音色，传其它值（如旧的 `zf_001`）返回 400。建议省略 |
| `sid` | integer | 否 | — | 兼容字段：仅 `0` 有效，其它值返回 400。建议省略 |

### 4.2 成功响应

- 状态码 `200`，响应体即音频文件内容，可直接保存为 `.wav` / `.mp3` 或交给播放器。
- 音频规格：16000 Hz、单声道；WAV 为 16-bit PCM，MP3 为 64 kbps。

### 4.3 错误响应（JSON）

| 状态码 | 含义 | 典型 detail |
| --- | --- | --- |
| 400 | 参数不合法 | 文本为空/超长、format 不支持、voice/sid 不是唯一可用值 |
| 401 | 口令缺失或错误 | `invalid or missing API token` |
| 422 | 请求体结构不对 | 如 text 不是字符串、JSON 格式错误（FastAPI 自动返回字段级说明） |

## 5. GET /tts —— 合成（参数版）

参数走 URL 查询字符串，与 POST 版同名同义（无 `stream`，固定非流式）：

```
GET /tts?text=你好，世界&speed=1.0&format=mp3&token=<口令>
```

浏览器地址栏直接打开即可出声试听（中文参数需 URL 编码，浏览器一般会自动处理）。

## 6. GET /health

```json
{
  "status": "ok",
  "engine": "matcha-icefall-zh-en + vocos-16khz-univ",
  "model": "matcha-icefall-zh-en",
  "sample_rate": 16000,
  "num_speakers": 1,
  "num_threads": 2
}
```

## 7. GET /voices

```json
{
  "voices": [
    {"sid": 0, "name": "matcha_zh_en", "lang": "zh-CN/en-US",
     "gender": "female", "label": "中文女声(Matcha 单音色, 中英双语)"}
  ],
  "total": 1,
  "note": "单音色模型, voice/sid 参数可省略"
}
```

## 8. 调用示例

### 8.1 curl（POST，存为 MP3）

```bash
curl -X POST https://tts.250886.xyz/tts \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <口令>" \
  -d '{"text":"夜幕降临，星光洒满湖面。","format":"mp3","speed":1.0}' \
  -o out.mp3
```

### 8.2 curl（流式 WAV，边下边播可用 ffplay 等）

```bash
curl -X POST https://tts.250886.xyz/tts \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <口令>" \
  -d '{"text":"第一句。第二句。第三句。","format":"wav","stream":true}' \
  -o out.wav
```

### 8.3 Python（requests）

```python
import requests

resp = requests.post(
    "https://tts.250886.xyz/tts",
    headers={"X-API-Key": "<口令>"},
    json={"text": "你好，这是一段语音合成测试。", "format": "mp3", "speed": 1.0},
    timeout=60,
)
resp.raise_for_status()
with open("out.mp3", "wb") as f:
    f.write(resp.content)
```

## 9. 行为与注意事项

- **文本规范化**：全角转半角；句号、感叹号、问号、分号、省略号作断句符且不读出；括号、引号、装饰符号会被剔除；破折号转为逗号停顿；数字按中文数字规则读（内置日期/电话/数字规则），小数点（如 3.14）不会被误断句。
- **长句处理**：单句超过 120 字符时按逗号再切分逐段合成后拼接，段间 0.12 秒静音。
- **并发**：服务端合成是串行执行的（模型非线程安全），多个请求会排队；单个短句通常 1 秒内返回，800 字符长文本请预留更长超时（建议 ≥60 秒）并优先用 `stream=true`。
- **语言**：中文、英文及中英混排；纯英文长文可读但韵律偏中文腔，属模型特性。
- **已停用**：原 Kokoro 的 103 个音色名（zf_001、zm_009、af_maple 等）已随引擎切换失效，调用会返回 400。
