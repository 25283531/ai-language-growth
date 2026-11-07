# apps/android-audio-prototype — M1 最小音频链路原型

M1 阶段与 Web 教学实验台并行的一个**最小 Android 音频链路原型**，用于尽早暴露浏览器与 Android 在录音权限、播放中断、后台音频、蓝牙设备、播放器行为上的差异。它不是 M3 的正式客户端（`apps/android` 才是）。

## 它做什么 / 不做什么

做：

- 申请 `RECORD_AUDIO` 运行时权限；
- 用 `MediaRecorder` 录音到本地缓存文件（`.m4a` / AAC），用 `MediaPlayer` 本地回放；
- 点「提交作答」时，把本地文件路径包装成 `audioRef`（形如 `file:///...`），
  POST 到后端 `/lessons/{id}/turn`，把响应里的 `directive.teacherUtterance` 显示出来。

不做（**这是刻意的产品边界，见 DECISIONS.md D-024 约束一**）：

- **不做任何教学决策**。教什么、下一句说什么、是否换方法、是否晋级，全部由后端编排器决定；
  本客户端只负责采集孩子回应并渲染后端下发的 directive。
- 不内置任何服务商或模型名称、不内置 TTS/ASR 参数（D-024 约束二）。
- 不修改学习者能力状态、不产生「已掌握」结论（D-024 约束三）。
- 不真正上传音频字节：`audioRef` 目前只是本地文件引用字符串，后端无法跨设备读取。
  对象存储上传与可访问 URL 属于后续里程碑。

## 目录

```
settings.gradle.kts
build.gradle.kts                     # 根：插件版本（Gradle 8.7 / AGP 8.5.2 / Kotlin 1.9.24）
gradle/wrapper/gradle-wrapper.properties
app/build.gradle.kts                 # minSdk 26 / targetSdk 34 / compileSdk 34 / JDK 17
app/src/main/AndroidManifest.xml     # RECORD_AUDIO + INTERNET、usesCleartextTraffic（仅原型）
app/src/main/res/values/strings.xml  # backend_base_url / lesson_id / learner_id 配置
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
- `lesson_id` / `learner_id` 是演示用固定值；正式流程应先调 `POST /lessons/start`
  获取 `lessonSessionId` 再填进去。

## 请求 / 响应形状

请求体与 `packages/shared-contracts/src/teaching.ts` 的 `turnRequestSchema` 对齐：

```json
{
  "learnerId": "m1_demo_learner",
  "response": {
    "text": null,
    "audioRef": "file:///data/.../m1_answer_xxx.m4a",
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
- 录音文件写在应用私有 `cacheDir`，不涉及外部存储权限，也不上传原始音频。
- 原型不做身份校验、不做音频加密、不长期保留原始录音（与 README 顶层隐私约定一致）。

## 已知限制（M1）

- **本机未做编译验证**：开发环境没有 Android SDK 与 Gradle，Gradle/AGP/Kotlin/JDK
  版本组合与 Manifest 权限仅做静态自检；真实编译由 GitHub Actions 的
  `ubuntu-latest` runner（预装 Android SDK）执行 `assembleDebug` 完成。
  请勿把「配置文件看起来正确」当成「已编译通过」。
- **默认 `lesson_id` / `learner_id` 不是数据库中的真实记录**：
  `strings.xml` 里的 `m1_demo_lesson` / `m1_demo_learner` 只用于演示录音 → 播放 →
  提交音频引用的链路。直接点「提交作答」时后端会因课堂不存在而返回错误。
  正式联调需先调 `POST /lessons/start` 取得 `lessonSessionId`，并使用数据库中
  已有的学习者（例如 `child-m1-demo`）。
- **不上传音频字节**：`audioRef` 只是把本地文件路径包装成引用字符串，
  对象存储上传与后端可访问的 URL 留待后续里程碑。
- 教学决策仍在后端，本原型只渲染 `directive.teacherUtterance`，不含任何教学判断。
