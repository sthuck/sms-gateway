package com.sthuck.smsgateway.data.local

import com.sthuck.smsgateway.sms.AssembledSms
import com.sthuck.smsgateway.sms.IncomingSmsMapper
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Inserts an assembled inbound SMS into the local outbox.
 * Duplicate [QueuedMessageEntity.deviceMsgId] values are a no-op.
 * Does not perform any networking (the STH-13 uploader drains this table).
 */
@Singleton
class IncomingSmsEnqueuer @Inject constructor(
    private val dao: QueuedMessageDao,
) {
    private val mutex = Mutex()

    suspend fun enqueue(message: AssembledSms, nowEpochMs: Long = System.currentTimeMillis()): String =
        mutex.withLock {
            val ordinal = dao.countByContentKey(message.contentKey)
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
            deviceMsgId
        }
}
