package com.sthuck.smsgateway

import android.app.Application
import android.content.Context
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.sthuck.smsgateway.crypto.DeviceKeyAccess
import com.sthuck.smsgateway.data.local.QueuedMessageDao
import com.sthuck.smsgateway.keepalive.KeepaliveController
import com.sthuck.smsgateway.pairing.PairingCredentialStore
import com.sthuck.smsgateway.upload.OutboxHousekeeping
import com.sthuck.smsgateway.upload.UploadScheduler
import dagger.hilt.android.HiltAndroidApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
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

    @Inject
    lateinit var housekeeping: OutboxHousekeeping

    @Inject
    lateinit var keepaliveController: KeepaliveController

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(workerFactory)
            .build()

    override fun onCreate() {
        super.onCreate()
        // Restore the preferred Keystore alias before any already-scheduled
        // worker can run (closes the restore/enqueue race).
        val paired = runBlocking {
            val creds = credentialStore.current()
            deviceKeyStore.restorePreferredActiveAlias(creds.activeKeyAlias)
            creds.isPaired
        }
        if (paired) {
            keepaliveController.ensureStarted()
        }
        appScope.launch {
            maybeUnparkAfterUpgrade()
            housekeeping.enforceLimits()
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
