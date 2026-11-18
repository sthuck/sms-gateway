package com.sthuck.smsgateway.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import com.sthuck.smsgateway.data.local.IncomingSmsEnqueuer
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Receives incoming SMS, reassembles multipart PDUs, and enqueues them locally.
 * No networking is done here.
 */
@AndroidEntryPoint
class SmsReceiver : BroadcastReceiver() {

    @Inject
    lateinit var enqueuer: IncomingSmsEnqueuer

    @Inject
    lateinit var simSlotResolver: SimSlotResolver

    @Inject
    lateinit var permissionStore: SmsPermissionStore

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        if (!permissionStore.areGranted(context)) return

        val pdus = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val parts = pdus.map { message ->
            SmsPduPart(
                originatingAddress = message.displayOriginatingAddress
                    ?: message.originatingAddress,
                body = message.messageBody ?: message.displayMessageBody.orEmpty(),
                timestampMillis = message.timestampMillis,
            )
        }
        if (parts.isEmpty()) return

        val simSlot = simSlotResolver.resolve(intent)
        val pending = goAsync()
        scope.launch {
            try {
                IncomingSmsMapper.reassemble(parts, simSlot).forEach { assembled ->
                    enqueuer.enqueue(assembled)
                }
            } finally {
                pending.finish()
            }
        }
    }

    private companion object {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    }
}
