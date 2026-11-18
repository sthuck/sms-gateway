package com.sthuck.smsgateway.data.local

import androidx.work.ExistingWorkPolicy
import com.sthuck.smsgateway.sms.AssembledSms
import com.sthuck.smsgateway.sms.IncomingSmsMapper
import com.sthuck.smsgateway.upload.OutboxHousekeeping
import com.sthuck.smsgateway.upload.UploadWorkScheduler
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

class IncomingSmsEnqueuerTest {

    @Test
    fun ordinalSurvivesUploadDeleteSoSecondIdenticalSmsIsNotDropped() = runBlocking {
        val dao = FakeDao()
        val scheduler = RecordingScheduler()
        val enqueuer = IncomingSmsEnqueuer(dao, scheduler, OutboxHousekeeping(dao))
        val sms = sampleSms()

        val firstId = enqueuer.enqueue(sms, nowEpochMs = 1_000L)
        assertEquals(IncomingSmsMapper.deviceMsgId(sms.contentKey, 0), firstId)

        // Simulate successful upload deleting the row (counter must remain).
        dao.deleteByIds(listOf(firstId))
        assertTrue(dao.rows.isEmpty())

        val secondId = enqueuer.enqueue(sms, nowEpochMs = 2_000L)
        assertEquals(IncomingSmsMapper.deviceMsgId(sms.contentKey, 1), secondId)
        assertEquals(1, dao.rows.size)
        assertEquals(2, scheduler.enqueueCount.get())
        assertEquals(0, scheduler.lastDelayMs.get())
    }

    private fun sampleSms() = AssembledSms(
        sender = "+15551234567",
        body = "OTP 123456",
        receivedAt = "2026-11-18T09:45:12Z",
        timestampSeconds = 1_794_995_112L,
        simSlot = 0,
        contentKey = IncomingSmsMapper.contentKey(
            IncomingSmsMapper.DIRECTION_INBOUND,
            "+15551234567",
            1_794_995_112L,
            "OTP 123456",
        ),
    )

    private class RecordingScheduler : UploadWorkScheduler {
        val enqueueCount = AtomicInteger(0)
        val lastDelayMs = AtomicInteger(0)
        override fun enqueueUpload(policy: ExistingWorkPolicy?, initialDelayMs: Long) {
            enqueueCount.incrementAndGet()
            lastDelayMs.set(initialDelayMs.toInt())
        }
        override fun enqueueDelayedUntil(nextAttemptAtEpochMs: Long) = Unit
        override fun defaultPolicyForDelay(initialDelayMs: Long): ExistingWorkPolicy =
            if (initialDelayMs == 0L) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.APPEND_OR_REPLACE
    }

    private class FakeDao : QueuedMessageDao {
        val rows = mutableListOf<QueuedMessageEntity>()
        private val counters = mutableMapOf<String, Int>()

        override suspend fun getAll() = rows.toList()
        override suspend fun countPending() = rows.count { !it.parked }
        override suspend fun countAll() = rows.size
        override fun observePendingCount(): Flow<Int> = flowOf(rows.count { !it.parked })
        override fun observeParkedCount(): Flow<Int> = flowOf(rows.count { it.parked })
        override fun observePendingRecent(limit: Int) = flowOf(rows.filter { !it.parked }.take(limit))
        override fun observeParkedRecent(limit: Int) = flowOf(rows.filter { it.parked }.take(limit))
        override suspend fun countByContentKey(contentKey: String) =
            rows.count { it.contentKey == contentKey }
        override suspend fun getNextOrdinal(contentKey: String) = counters[contentKey]
        override suspend fun upsertContentKeyCounter(counter: ContentKeyCounterEntity) {
            counters[counter.contentKey] = counter.nextOrdinal
        }
        override suspend fun getReadyForUpload(nowEpochMs: Long, limit: Int) =
            rows.filter { !it.parked && it.nextAttemptAtEpochMs <= nowEpochMs }.take(limit)
        override suspend fun earliestPendingAttemptAtEpochMs() =
            rows.filter { !it.parked }.minOfOrNull { it.nextAttemptAtEpochMs }
        override suspend fun getExpiredPending(cutoffEpochMs: Long) =
            rows.filter { !it.parked && it.createdAtEpochMs < cutoffEpochMs }
        override suspend fun getOldestPending(limit: Int) =
            rows.filter { !it.parked }.sortedBy { it.createdAtEpochMs }.take(limit)
        override suspend fun insert(message: QueuedMessageEntity): Long {
            if (rows.any { it.deviceMsgId == message.deviceMsgId }) return -1L
            rows += message
            return 1L
        }
        override suspend fun deleteById(deviceMsgId: String) {
            rows.removeAll { it.deviceMsgId == deviceMsgId }
        }
        override suspend fun deleteByIds(deviceMsgIds: List<String>) {
            rows.removeAll { it.deviceMsgId in deviceMsgIds }
        }
        override suspend fun deleteAll() = rows.clear()
        override suspend fun park(deviceMsgId: String, error: String, nowEpochMs: Long) {
            val i = rows.indexOfFirst { it.deviceMsgId == deviceMsgId }
            if (i >= 0) rows[i] = rows[i].copy(parked = true, lastError = error)
        }
        override suspend fun markRetry(
            deviceMsgIds: List<String>,
            nextAttemptAtEpochMs: Long,
            error: String?,
        ) = Unit
        override suspend fun unparkAll(nowEpochMs: Long) {
            rows.replaceAll { if (it.parked) it.copy(parked = false, lastError = null) else it }
        }
    }
}
