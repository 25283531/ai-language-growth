# apps/android-audio-prototype — M1 最小音频链路原型

M1 阶段与 Web 教学实验台并行的一个**最小 Android 音频链路原型**，用于尽早暴露浏览器与 Android 在录音权限、播放中断、后台音频、蓝牙设备、播放器行为上的差异。它不是 M3 的正式客户端（`apps/android` 才是）。

## 它做什么 / 不做什么

做：

- 申请 `RECORD_AUDIO` 运行时权限；
- 用 `MediaRecorder` 录音到本地缓存文件（`.m4a` / AAC），用 `MediaPlayer` 本地回放；
- 点「开始课堂」时调用 `POST /lessons/start` 获取真实 `lessonSessionId`；
- 点「提交作答」时先向 `/speech/quota/reserve` 预留 ASR 秒数；额度不足时在本地阻断，
  不上传录音。通过租约校验后才把录音字节 POST 到 `/media/audio/uploads`，再用服务端可读取的
  `audioRef` 调用 `/lessons/{id}/turn`；成功结算、失败释放租约；
- 显示并播放后端返回的老师语音，支持请求慢速和重播。

不做（**这是刻意的产品边界，见 DECISIONS.md D-024 约束一**）：

- **不做任何教学决策**。教什么、下一句说什么、是否换方法、是否晋级，全部由后端编排器决定；
  本客户端只负责采集孩子回应并渲染后端下发的 directive。
- 不内置任何服务商或模型名称、不内置 TTS/ASR 参数（D-024 约束二）。
- 不修改学习者能力状态、不产生「已掌握」结论（D-024 约束三）。
- 不在客户端内置任何长期供应商密钥；上传端点是 M1 原型用的短期文件缓存。
  正式版本需要对象存储、监护人授权、自动过期和删除策略。

## 目录

```
settings.gradle.kts
build.gradle.kts                     # 根：插件版本（Gradle 8.7 / AGP 8.5.2 / Kotlin 1.9.24）
gradle/wrapper/gradle-wrapper.properties
app/build.gradle.kts                 # minSdk 26 / targetSdk 34 / compileSdk 34 / JDK 17
app/src/main/AndroidManifest.xml     # RECORD_AUDIO + INTERNET、usesCleartextTraffic（仅原型）
app/src/main/res/values/strings.xml  # backend_base_url / learner_id 配置
app/src/main/java/.../MainActivity.kt
```

布局全部用代码构建，没有 XML 布局资源；只依赖 Android 框架 API 与 Kotlin 标准库，
不引入 AndroidX、Compose 或任何网络库。

## 配置后端地址

`app/src/main/res/values/strings.xml`：

```xml
<string name="backend_base_url">http://10.0.2.2:3100/api/v1</string>
```

- Android 模拟器用 `10.0.2.2` 访问宿主机；真机请改为宿主机局域网 IP。
- `deploy/docker/docker-compose.yml` 默认把宿主机 `3100` 映射到容器内 `3000`，
  容器内 `PORT=3000`；所以模拟器上 `3100` 是正确的对外端口。
- 后端需以 `AI_GATEWAY_MODE=mock` 启动（不需要任何密钥、不产生费用）。
- `learner_id` 需要是远程 seed 中存在的测试学习者；课堂 ID 由应用启动后的
  「开始课堂」按钮动态获取。

## 请求 / 响应形状

请求体与 `packages/shared-contracts/src/teaching.ts` 的 `turnRequestSchema` 对齐：

```json
{
  "learnerId": "child-m1-demo",
  "response": {
    "text": null,
  "audioRef": "http://<backend>/api/v1/media/audio/<sha256-24>.m4a",
    "audioDurationMs": 0,
    "selectedImageId": null,
    "requestedSlower": false,
    "requestedRepeat": false
  },
  "idempotencyKey": "<uuid>",
  "clientTimestamp": "<ISO-8601 UTC>"
}
```

响应只读取 `directive.teacherUtterance`（以及用于展示的 `turnIndex`）。

## 构建

本地（需 Android SDK + JDK 17 + Gradle 8.7）：

```bash
cd apps/android-audio-prototype
gradle --no-daemon assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

CI 由 `.github/workflows/android-audio-prototype.yml` 负责：`workflow_dispatch` 或
`apps/android-audio-prototype/**` 路径变更触发，setup-java 17 + setup-gradle 8.7，
执行 `assembleDebug` 并把 APK 上传为 artifact。

> 注意：本仓库未提交 `gradlew` / `gradle-wrapper.jar`，因此 CI 使用 setup-gradle
> 安装的 Gradle 直接调用；`gradle-wrapper.properties` 仅供本地 Android Studio 使用。
> 若要在本地使用 wrapper，执行一次 `gradle wrapper` 生成 `gradlew` 与 jar 即可。

## 安全说明（仅原型）

- `android:usesCleartextTraffic="true"` 和 HTTP 明文后端地址只用于 M1 本地联调，
  **正式客户端必须改为 HTTPS 并移除该标志**。
- 录音文件写在应用私有 `cacheDir`，不涉及外部存储权限；提交时会上传到原型服务端缓存。
- 原型不做身份校验、不做音频加密、不长期保留原始录音（与 README 顶层隐私约定一致）。

## 额度控制边界

- 默认非会员每天每类云语音 300 秒（ASR、云端 TTS、发音评测分别计量），可由服务端环境变量
  `ASR_DAILY_QUOTA_SECONDS`、`TTS_DAILY_QUOTA_SECONDS`、`PRONUNCIATION_DAILY_QUOTA_SECONDS` 调整。
- 本原型已实现 ASR 上传前和云端 TTS 播放前的服务端租约与本地阻断。TTS 播放通过带租约请求头
  下载音频，播放结束按实际时长结算，失败或中断释放租约。发音评测的端侧 SDK 尚未随仓库发布，
  接入时必须复用同一套 `reserve → SDK 调用 → settle/release` 流程。
- 当前课堂接口仍由后端编排器生成教学语音，不能宣称“ASR/TTS 已全部在 APP 端”。正式 Android
  客户端接入供应商 SDK 后，才会把媒体链路迁移为受限短期凭证直连。

## 已知限制（M1）

- **本机未做编译验证**：开发环境没有 Android SDK 与 Gradle，Gradle/AGP/Kotlin/JDK
  版本组合与 Manifest 权限仅做静态自检；真实编译由 GitHub Actions 的
  `ubuntu-latest` runner（预装 Android SDK）执行 `assembleDebug` 完成。
  请勿把「配置文件看起来正确」当成「已编译通过」。
- **学习者必须存在于服务端数据库**：默认使用 seed 的 `child-m1-demo`；如果远程环境
  没有该学习者，先执行迁移和 seed，再在 `strings.xml` 中改成测试 ID。
- **上传文件是原型缓存**：服务端限制单个文件 10 MB，使用内容指纹命名；
  当前没有自动过期清理，也没有家长身份校验。
- 教学决策仍在后端，本原型只渲染 `directive.teacherUtterance`，不含任何教学判断。
