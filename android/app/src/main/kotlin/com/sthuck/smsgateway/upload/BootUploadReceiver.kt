package com.sthuck.smsgateway.upload

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

/** Re-schedules outbox upload after reboot (WorkManager + app start also cover this). */
@AndroidEntryPoint
class BootUploadReceiver : BroadcastReceiver() {

    @Inject
    lateinit var uploadScheduler: UploadScheduler

    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED &&
            intent?.action != Intent.ACTION_LOCKED_BOOT_COMPLETED
        ) {
            return
        }
        uploadScheduler.enqueueUpload()
    }
}
