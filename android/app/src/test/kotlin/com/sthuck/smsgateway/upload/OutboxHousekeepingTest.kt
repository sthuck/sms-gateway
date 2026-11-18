package com.sthuck.smsgateway.upload

import com.sthuck.smsgateway.data.local.ContentKeyCounterEntity
import com.sthuck.smsgateway.data.local.QueuedMessageDao
import com.sthuck.smsgateway.data.local.QueuedMessageEntity
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OutboxHousekeepingTest {

    @Test
    fun parksExpiredPendingWithoutDeleting() = runBlocking {
        val dao = FakeDao()
        val now = 10_000_000L
        dao.rows += sample("old", createdAt = now - UploadDefaults.OUTBOX_TTL_MS - 1)
        dao.rows += sample("fresh", createdAt = now - 1_000L)
        val result = OutboxHousekeeping(dao).enforceLimits(now)
        assertEquals(1, result.expiredParked)
        assertEquals(0, result.overCapParked)
        assertEquals(2, dao.rows.size)
        val old = dao.rows.single { it.deviceMsgId == "old" }
        assertTrue(old.parked)
        assertTrue(old.lastError!!.startsWith(UploadDefaults.PARK_REASON_EXPIRED_TTL))
        assertTrue(!dao.rows.single { it.deviceMsgId == "fresh" }.parked)
    }

    @Test
    fun parksOldestWhenOverCap() = runBlocking {
        val dao = FakeDao()
        val now = 1_000L
        repeat(5) { i ->
            dao.rows += sample("sms-$i", createdAt = i.toLong())
        }
        val result = OutboxHousekeeping(dao).enforceLimits(now, maxRows = 3, ttlMs = UploadDefaults.OUTBOX_TTL_MS)
        assertEquals(0, result.expiredParked)
        assertEquals(2, result.overCapParked)
        assertEquals(3, dao.rows.count { !it.parked })
        assertTrue(dao.rows.single { it.deviceMsgId == "sms-0" }.parked)
        assertTrue(dao.rows.single { it.deviceMsgId == "sms-1" }.parked)
        assertTrue(
            dao.rows.single { it.deviceMsgId == "sms-0" }.lastError!!
                .startsWith(UploadDefaults.PARK_REASON_OVER_CAP),
        )
    }

    private fun sample(id: String, createdAt: Long) = QueuedMessageEntity(
        deviceMsgId = id,
        contentKey = id,
        sender = "+1",
        body = "x",
        receivedAt = "2026-11-18T09:45:12Z",
        direction = "inbound",
        createdAtEpochMs = createdAt,
    )

    private class FakeDao : QueuedMessageDao {
        val rows = mutableListOf<QueuedMessageEntity>()
        override suspend fun getAll() = rows.toList()
        override suspend fun countPending() = rows.count { !it.parked }
        override suspend fun countAll() = rows.size
        override fun observePendingCount(): Flow<Int> = flowOf(0)
        override fun observeParkedCount(): Flow<Int> = flowOf(0)
        override fun observePendingRecent(limit: Int): Flow<List<QueuedMessageEntity>> =
            flowOf(emptyList())
        override fun observeParkedRecent(limit: Int): Flow<List<QueuedMessageEntity>> =
            flowOf(emptyList())
        override suspend fun countByContentKey(contentKey: String) = 0
        override suspend fun getNextOrdinal(contentKey: String) = null
        override suspend fun upsertContentKeyCounter(counter: ContentKeyCounterEntity) = Unit
        override suspend fun getReadyForUpload(nowEpochMs: Long, limit: Int): List<QueuedMessageEntity> =
            emptyList()
        override suspend fun earliestPendingAttemptAtEpochMs() = null
        override suspend fun getExpiredPending(cutoffEpochMs: Long) =
            rows.filter { !it.parked && it.createdAtEpochMs < cutoffEpochMs }
                .sortedBy { it.createdAtEpochMs }
        override suspend fun getOldestPending(limit: Int) =
            rows.filter { !it.parked }.sortedBy { it.createdAtEpochMs }.take(limit)
        override suspend fun insert(message: QueuedMessageEntity) = 1L
        override suspend fun deleteById(deviceMsgId: String) = Unit
        override suspend fun deleteByIds(deviceMsgIds: List<String>) = Unit
        override suspend fun deleteAll() = Unit
        override suspend fun park(deviceMsgId: String, error: String, nowEpochMs: Long) {
            val i = rows.indexOfFirst { it.deviceMsgId == deviceMsgId }
            if (i >= 0) {
                rows[i] = rows[i].copy(parked = true, lastError = error, nextAttemptAtEpochMs = nowEpochMs)
            }
        }
        override suspend fun markRetry(
            deviceMsgIds: List<String>,
            nextAttemptAtEpochMs: Long,
            error: String?,
        ) = Unit
        override suspend fun unparkAll(nowEpochMs: Long) = Unit
    }
}
