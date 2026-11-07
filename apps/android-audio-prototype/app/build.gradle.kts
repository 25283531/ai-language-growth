plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.alg.audio.prototype"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.alg.audio.prototype"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0-m1"
    }

    // 布局全部用代码构建，不引入任何 XML 布局资源；也不依赖 AndroidX / Compose。
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}
