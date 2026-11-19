package com.sthuck.smsgateway

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner
import androidx.work.Configuration
import androidx.work.WorkManager
import dagger.hilt.android.testing.HiltTestApplication

/**
 * Stand-in for the Hilt 2.60-removed `HiltTestRunner`: force
 * [HiltTestApplication] for `@HiltAndroidTest`, and initialize WorkManager
 * because the app under test removes `WorkManagerInitializer` and expects
 * [Configuration.Provider] on [SmsGatewayApplication].
 */
class SmsGatewayHiltTestRunner : AndroidJUnitRunner() {
    override fun newApplication(
        cl: ClassLoader?,
        className: String?,
        context: Context?,
    ): Application {
        val app = super.newApplication(cl, HiltTestApplication::class.java.name, context)
        if (!WorkManager.isInitialized()) {
            WorkManager.initialize(app, Configuration.Builder().build())
        }
        return app
    }
}
