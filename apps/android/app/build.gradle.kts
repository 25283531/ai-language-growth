plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.alg.languagegrowth"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.alg.languagegrowth"
        minSdk = 26
        targetSdk = 34
        versionName = providers.gradleProperty("appVersionName").orElse("0.0.3").get()
        versionCode = providers.gradleProperty("appVersionCode").orElse("3").get().toInt()
    }

    val releaseStoreFile = System.getenv("ANDROID_KEYSTORE_PATH")
    val releaseStorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
    val releaseKeyAlias = System.getenv("ANDROID_KEY_ALIAS")
    val releaseKeyPassword = System.getenv("ANDROID_KEY_PASSWORD")
    signingConfigs {
        if (!releaseStoreFile.isNullOrBlank()) {
            create("release") {
                storeFile = file(releaseStoreFile)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }
    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            if (!releaseStoreFile.isNullOrBlank()) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    // 端侧 TTS 模型体积大（约 145MB），必须不压缩打包：
    // 否则 aapt 压缩阶段会 Java heap space OOM，且原生层需要直接读未压缩资源。
    androidResources {
        noCompress += listOf("onnx", "fst")
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.10.01"))
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    // 教师语音播放/重播使用协程串行任务与取消清理，显式声明避免依赖传递解析差异。
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    testImplementation("junit:junit:4.13.2")
    // Android 单测里的 org.json 是空壳；显式引入真实实现，课文解析测试才能跑。
    testImplementation("org.json:json:20240303")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
