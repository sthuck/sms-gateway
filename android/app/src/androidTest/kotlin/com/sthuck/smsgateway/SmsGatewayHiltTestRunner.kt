package com.sthuck.smsgateway

import android.app.Application
import android.content.Context
import androidx.test.runner.AndroidJUnitRunner
import androidx.work.Configuration
import androidx.work.WorkManager
import dagger.hilt.android.testing.HiltTestApplication

/**
 * Stand-in for the Hilt 2.60-removed `HiltTestRunner`: force
 * [HiltTestApplication] for `@HiltAndroidTest`. WorkManager is initialized
 * in [callApplicationOnCreate] (not [newApplication]) because the Application
 * context is not usable until then, and the app under test removes
 * `WorkManagerInitializer` in favor of [SmsGatewayApplication]'s
 * `Configuration.Provider`.
 */
class SmsGatewayHiltTestRunner : AndroidJUnitRunner() {
    override fun newApplication(
        cl: ClassLoader?,
        className: String?,
        context: Context?,
    ): Application =
        super.newApplication(cl, HiltTestApplication::class.java.name, context)

    override fun callApplicationOnCreate(app: Application) {
        if (!WorkManager.isInitialized()) {
            WorkManager.initialize(app, Configuration.Builder().build())
        }
        super.callApplicationOnCreate(app)
    }
}
