plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt)
}

/**
 * Resolve a value from a Gradle `-P` property first, then the process
 * environment. Blank strings are treated as missing.
 *
 * Release signing / versioning secrets are never committed; CI passes them
 * via env (see docs/android/releasing.md and STH-19).
 */
fun propOrEnv(name: String): String? {
    val fromProp = (findProperty(name) as String?)?.trim()?.takeIf { it.isNotEmpty() }
    if (fromProp != null) return fromProp
    return System.getenv(name)?.trim()?.takeIf { it.isNotEmpty() }
}

val appVersionName = propOrEnv("APP_VERSION_NAME") ?: "0.1.0"
val appVersionCode = propOrEnv("APP_VERSION_CODE")?.toIntOrNull() ?: 1

val releaseKeystoreFilePath = propOrEnv("ANDROID_KEYSTORE_FILE")
val releaseKeystorePassword = propOrEnv("ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = propOrEnv("ANDROID_KEY_ALIAS")
val releaseKeyPassword = propOrEnv("ANDROID_KEY_PASSWORD")

val releaseKeystoreFile =
    releaseKeystoreFilePath?.let { path -> file(path).takeIf { it.isFile } }
val releaseSigningReady =
    releaseKeystoreFile != null &&
        !releaseKeystorePassword.isNullOrBlank() &&
        !releaseKeyAlias.isNullOrBlank() &&
        !releaseKeyPassword.isNullOrBlank()

android {
    namespace = "com.sthuck.smsgateway"
    // Compose BOM 2026.09.00 requires API 37+. Platform 35 is still installed
    // for reference; targetSdk stays 35, minSdk stays 26.
    compileSdk {
        version = release(37) {
            minorApiLevel = 2
        }
    }

    defaultConfig {
        applicationId = "com.sthuck.smsgateway"
        minSdk = 26
        targetSdk = 35
        versionCode = appVersionCode
        versionName = appVersionName

        // Hilt 2.60 removed HiltTestRunner; this runner swaps in HiltTestApplication.
        testInstrumentationRunner = "com.sthuck.smsgateway.SmsGatewayHiltTestRunner"

        // Heartbeat endpoint is draft-only; keep off until the backend ships.
        buildConfigField("boolean", "HEARTBEAT_ENABLED", "false")
    }

    flavorDimensions += "environment"
    productFlavors {
        create("dev") {
            dimension = "environment"
            isDefault = true
            applicationIdSuffix = ".dev"
            versionNameSuffix = "-dev"
            val url = (findProperty("devBackendUrl") as String?) ?: "http://10.0.2.2:4010"
            buildConfigField("String", "BACKEND_URL", "\"$url\"")
        }
        create("prod") {
            dimension = "environment"
            val url = (findProperty("prodBackendUrl") as String?)
                ?: "https://sms.sthuck.info"
            buildConfigField("String", "BACKEND_URL", "\"$url\"")
        }
    }

    signingConfigs {
        if (releaseSigningReady) {
            create("release") {
                storeFile = releaseKeystoreFile
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (releaseSigningReady) {
                signingConfig = signingConfigs.getByName("release")
                logger.lifecycle(
                    "Release signing: enabled (store=${releaseKeystoreFile!!.path}, alias=$releaseKeyAlias)",
                )
            } else {
                // Debug/CI keep working without secrets. Tag release workflow
                // decodes ANDROID_KEYSTORE_BASE64 into ANDROID_KEYSTORE_FILE.
                logger.lifecycle(
                    "Release signing: SKIPPED — missing ANDROID_KEYSTORE_FILE " +
                        "(or file not found), ANDROID_KEYSTORE_PASSWORD, " +
                        "ANDROID_KEY_ALIAS, and/or ANDROID_KEY_PASSWORD " +
                        "(env or Gradle -P). Producing an unsigned release APK. " +
                        "See docs/android/releasing.md.",
                )
            }
        }
        debug {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    sourceSets {
        getByName("test") {
            kotlin.directories.add("src/sharedTest/kotlin")
        }
        getByName("androidTest") {
            kotlin.directories.add("src/sharedTest/kotlin")
            // Room MigrationTestHelper reads exported schemas from assets.
            assets.directories.add("$projectDir/schemas")
        }
    }

    testOptions {
        unitTests.isIncludeAndroidResources = false
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)

    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.androidx.hilt.work)
    ksp(libs.androidx.hilt.compiler)

    implementation(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    ksp(libs.androidx.room.compiler)
    androidTestImplementation(libs.androidx.room.testing)

    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.androidx.datastore.preferences)

    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode.scanning)

    implementation(libs.retrofit)
    implementation(libs.retrofit.kotlinx.serialization)
    implementation(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)

    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.rules)
    androidTestImplementation(libs.androidx.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.okhttp.mockwebserver)
    androidTestImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(libs.hilt.android.testing)
    kspAndroidTest(libs.hilt.compiler)
}
