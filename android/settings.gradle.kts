pluginManagement {
    repositories {
        // No content filters: filtered google() can resolve com.google.*
        // metadata without serving the jar, and Gradle then fails looking
        // only at that repo (seen in CI as missing protobuf/guava jars).
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
    }
}

rootProject.name = "sms-gateway-android"
include(":app")
