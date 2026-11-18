package com.sthuck.smsgateway.data.local

import com.sthuck.smsgateway.sms.AssembledSms
import com.sthuck.smsgateway.sms.IncomingSmsMapper
import com.sthuck.smsgateway.upload.OutboxHousekeeping
import com.sthuck.smsgateway.upload.UploadWorkScheduler
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Inserts an assembled inbound SMS into the local outbox and schedules
 * the WorkManager uploader. Duplicate [QueuedMessageEntity.deviceMsgId]
 * values are a no-op (idempotent retries). Ordinals come from a persistent
 * content-key counter so uploads that delete rows do not reset the sequence.
 */
@Singleton
class IncomingSmsEnqueuer @Inject constructor(
    private val dao: QueuedMessageDao,
    private val uploadScheduler: UploadWorkScheduler,
    private val housekeeping: OutboxHousekeeping,
) {
    private val mutex = Mutex()

    suspend fun enqueue(message: AssembledSms, nowEpochMs: Long = System.currentTimeMillis()): String =
        mutex.withLock {
            housekeeping.enforceLimits(nowEpochMs)
            val ordinal = dao.allocateOrdinal(message.contentKey)
            val deviceMsgId = IncomingSmsMapper.deviceMsgId(message.contentKey, ordinal)
            dao.insert(
                QueuedMessageEntity(
                    deviceMsgId = deviceMsgId,
                    contentKey = message.contentKey,
                    sender = message.sender,
                    body = message.body,
                    receivedAt = message.receivedAt,
                    direction = message.direction,
                    simSlot = message.simSlot,
                    createdAtEpochMs = nowEpochMs,
                ),
            )
            // Delay 0 → REPLACE so this SMS is not queued behind a backoff delay.
            uploadScheduler.enqueueUpload()
            deviceMsgId
        }
}
