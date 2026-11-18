package com.sthuck.smsgateway

import android.app.Application
import android.content.Context
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.sthuck.smsgateway.crypto.DeviceKeyAccess
import com.sthuck.smsgateway.data.local.QueuedMessageDao
import com.sthuck.smsgateway.pairing.PairingCredentialStore
import com.sthuck.smsgateway.upload.UploadScheduler
import dagger.hilt.android.HiltAndroidApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltAndroidApp
class SmsGatewayApplication : Application(), Configuration.Provider {

    @Inject
    lateinit var workerFactory: HiltWorkerFactory

    @Inject
    lateinit var uploadScheduler: UploadScheduler

    @Inject
    lateinit var queuedMessageDao: QueuedMessageDao

    @Inject
    lateinit var credentialStore: PairingCredentialStore

    @Inject
    lateinit var deviceKeyStore: DeviceKeyAccess

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(workerFactory)
            .build()

    override fun onCreate() {
        super.onCreate()
        appScope.launch {
            val creds = credentialStore.current()
            deviceKeyStore.restorePreferredActiveAlias(creds.activeKeyAlias)
            // Unpark on app update so rows stuck by older park rules can drain (STH-49).
            maybeUnparkAfterUpgrade()
            uploadScheduler.enqueueUpload()
        }
    }

    private suspend fun maybeUnparkAfterUpgrade() {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val last = prefs.getInt(KEY_LAST_VERSION_CODE, -1)
        if (last != BuildConfig.VERSION_CODE) {
            queuedMessageDao.unparkAll(System.currentTimeMillis())
            prefs.edit().putInt(KEY_LAST_VERSION_CODE, BuildConfig.VERSION_CODE).apply()
        }
    }

    private companion object {
        const val PREFS = "sms_gateway_app"
        const val KEY_LAST_VERSION_CODE = "last_version_code"
    }
}
