package com.sthuck.smsgateway.upload

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.sthuck.smsgateway.keepalive.KeepaliveController
import com.sthuck.smsgateway.pairing.PairingCredentialStore
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.runBlocking
import javax.inject.Inject

/**
 * Re-schedules outbox upload and restarts the keepalive FGS after reboot.
 *
 * Not `directBootAware`: WorkManager / Room / DataStore use credential-encrypted
 * storage, so we only listen for [Intent.ACTION_BOOT_COMPLETED] (after unlock).
 * See `docs/android-keepalive.md`.
 */
@AndroidEntryPoint
class BootUploadReceiver : BroadcastReceiver() {

    @Inject
    lateinit var uploadScheduler: UploadScheduler

    @Inject
    lateinit var keepaliveController: KeepaliveController

    @Inject
    lateinit var credentialStore: PairingCredentialStore

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return
        uploadScheduler.enqueueUpload()
        val paired = runBlocking { credentialStore.current().isPaired }
        if (paired) {
            keepaliveController.ensureStarted()
        }
    }
}
