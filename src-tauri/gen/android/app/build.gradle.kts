import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    ndkVersion = "28.2.13676358"
    namespace = "com.procweaver.mobile"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.procweaver.mobile"
        minSdk = 29
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = false
            isMinifyEnabled = false
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
    val releaseKey = System.getenv("PROCWEAVER_ANDROID_KEYSTORE")
    if (!releaseKey.isNullOrBlank()) {
        val signing = signingConfigs.create("procweaverRelease") {
            storeFile = file(releaseKey)
            storePassword = System.getenv("PROCWEAVER_ANDROID_STORE_PASSWORD") ?: error("Missing Android store password")
            keyAlias = System.getenv("PROCWEAVER_ANDROID_KEY_ALIAS") ?: error("Missing Android signing alias")
            keyPassword = System.getenv("PROCWEAVER_ANDROID_KEY_PASSWORD") ?: error("Missing Android key password")
        }
        buildTypes.getByName("release").signingConfig = signing
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")
