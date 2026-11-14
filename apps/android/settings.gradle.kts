pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // 端侧语音（sherpa-onnx 的 piper-phonemize）发布在 JitPack 上
        maven { url = uri("https://jitpack.io") }
    }
}

rootProject.name = "alg-android"
include(":app")
