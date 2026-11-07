// 顶层构建脚本：只声明插件版本，子模块按需应用。
// 工具链组合：Gradle 8.7 / AGP 8.5.2 / Kotlin 1.9.24 / JDK 17。
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
