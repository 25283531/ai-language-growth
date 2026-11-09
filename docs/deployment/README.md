# docs/deployment

# 部署说明

当前 Docker 部署包含 PostgreSQL、Redis、后端 API、用户 Web 和管理后台，使用一个 `docker-compose.yml` 一次性部署。数据库、Redis 和后端只在 Compose 内网开放；用户 Web 默认对外 `3002`，管理后台默认对外 `3001`，页面通过同源代理调用后端。完整的远程联调地址、迁移顺序、健康检查、备份还原和额度验收见 [`remote-services.md`](remote-services.md)。

## 必需环境变量

管理员账号通过部署服务器的 `.env` 中 `ADMIN_USERNAME`、`ADMIN_PASSWORD` 设置，Compose 启动时将其注入后端。管理员在管理页面登录后获得有效期 8 小时的 HttpOnly 会话 Cookie；所有管理 API 都由后端校验会话。请使用强随机密码并妥善保管 `.env`，不要提交到 GitHub。模型供应商凭据由管理后台加密写入数据库，`MODEL_CONFIG_ENCRYPTION_KEY` 更换后旧凭据无法解密。SMTP 也在后台“系统设置”页面配置并加密保存，不再要求把 SMTP 密码写入 Compose 环境变量。

会员语音额度由服务端按学习者等级决定：

- `guest`：云端 ASR、云端 TTS、音素评测均为 0，仅允许设备本地 TTS 和非语音智能功能。
- `free`：默认每类每日 300 秒，可用 `FREE_*_DAILY_QUOTA_SECONDS` 覆盖。
- `member`：默认每类每日 1800 秒，可用 `MEMBER_*_DAILY_QUOTA_SECONDS` 覆盖。
- `advanced`：服务端不限制额度，当前不在手机客户端开放购买或升级。

额度预留、结算和阻断由后端数据库账本负责，手机端计时不能提升等级或绕过额度。会员等级修改仅允许已登录管理员操作。

备份页面只备份数据库，不备份 `.cache/audio` 音频缓存；还原前会自动保护性备份当前数据库。远程备份可填写 WebDAV 或 OpenList 的 WebDAV 地址。

## 供应商配置

管理后台按页面分为模型接入、学习与记忆、任务路由和会员管理。模型接入页面按 LLM、TTS、普通 ASR、音素评测分栏；供应商预置包括阿里云百炼、火山引擎、百度千帆、科大讯飞、MiniMax、硅基流动、腾讯云语音、腾讯云混元、Ollama 和 OpenAI 兼容。每个服务可以单独覆盖 endpoint，防止供应商域名或区域变更导致业务代码失效。

普通 ASR 和音素评测始终是不同服务。火山普通 ASR 使用资源 ID 和录音识别请求；腾讯云语音使用 Secret ID/Secret Key 的 TC3 签名；腾讯云混元使用 OpenAI 兼容 API Key；硅基流动使用 API Key 和 OpenAI Audio 接口。Ollama 的 ASR/TTS 通过本地服务的 OpenAI Audio 兼容地址调用，服务器必须能访问已安装并支持相应任务的模型或兼容服务，不能假设任意 Ollama 模型都支持音频。

云端语音调用必须先由服务端签发额度租约。原始录音上传接口在读取音频请求体之前校验 ASR 租约；课堂语音提交、ASR/TTS/发音评测接口和合成音频下载均检查对应租约。无租约、租约过期、等级不允许或额度不足时，请求会被拒绝。非注册档案默认等级为 `guest`；会员等级只能由已登录管理员通过管理后台修改。每日用量在会员管理页按服务查看。
