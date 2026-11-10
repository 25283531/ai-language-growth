# Android 正式客户端（M3）

当前首个开发切片包含 Jetpack Compose 课堂首页：配置学习者编号和 HTTPS 后端地址，调用 `POST /api/v1/lessons/start`，并展示服务端返回的主题、教师指令、示范文本和本轮目标。客户端不选择课程内容或修改学习状态。

## 安全边界

- 只允许 HTTPS 后端地址；Android 明文流量已关闭。
- 当前远程联调服务 `http://152.136.230.132:3100` 不可直接用于本客户端。正式真机联调前需要为服务配置 HTTPS 入口。
- 当前切片仅覆盖开课与指令展示。录音、ASR、TTS、语音额度租约、监护人账户和家长中心会按 M3 后续节点逐步接入；在此之前仍使用 `apps/android-audio-prototype` 验证现有音频额度链路。

## 云端构建

`.github/workflows/android-client.yml` 在变更或手动触发时编译 APK 并上传 artifact。手动运行时默认版本为 `0.0.1`（version code `1`），可选择 `debug` 或 `release`。

正式发布包需要在 GitHub 仓库 Secrets 配置 `KEYSTORE_BASE64`、`KEYSTORE_PASSWORD`、`KEY_ALIAS`、`KEY_PASSWORD`。工作流也兼容旧的 `ANDROID_*` 命名。工作流只在运行器临时目录解码签名文件，不把 keystore、密码或密钥写入仓库。
M1 runs a parallel minimal Android audio prototype (record / play / slow-speed / upload) to surface browser-vs-Android differences early: permissions, interruption, background playback, Bluetooth, player behaviour.

The Android client talks to the same backend and the same `/lessons/{id}/turn` orchestrator as the web client.
