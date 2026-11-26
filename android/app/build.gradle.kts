plugins {
    id("com.android.application")
}

android {
    namespace = "ai.arena.terminal"
    compileSdk = 34

    defaultConfig {
        applicationId = "ai.arena.terminal"
        minSdk = 23
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            // Релиз подписывается отладочным ключом, чтобы APK можно было ставить сразу.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = false
    }
}
