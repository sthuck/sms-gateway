package com.sthuck.smsgateway.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import kotlinx.coroutines.flow.Flow

@Dao
interface QueuedMessageDao {
    @Query("SELECT * FROM queued_messages ORDER BY createdAtEpochMs ASC")
    suspend fun getAll(): List<QueuedMessageEntity>

    @Query("SELECT COUNT(*) FROM queued_messages")
    suspend fun countAll(): Int

    @Query("SELECT COUNT(*) FROM queued_messages WHERE parked = 0")
    suspend fun countPending(): Int

    @Query("SELECT COUNT(*) FROM queued_messages WHERE parked = 0")
    fun observePendingCount(): Flow<Int>

    @Query("SELECT COUNT(*) FROM queued_messages WHERE parked = 1")
    fun observeParkedCount(): Flow<Int>

    @Query(
        "SELECT * FROM queued_messages WHERE parked = 0 " +
            "ORDER BY createdAtEpochMs DESC LIMIT :limit",
    )
    fun observePendingRecent(limit: Int = 5): Flow<List<QueuedMessageEntity>>

    @Query(
        "SELECT * FROM queued_messages WHERE parked = 1 " +
            "ORDER BY createdAtEpochMs DESC LIMIT :limit",
    )
    fun observeParkedRecent(limit: Int = 5): Flow<List<QueuedMessageEntity>>

    @Query("SELECT COUNT(*) FROM queued_messages WHERE contentKey = :contentKey")
    suspend fun countByContentKey(contentKey: String): Int

    @Query("SELECT nextOrdinal FROM content_key_counters WHERE contentKey = :contentKey")
    suspend fun getNextOrdinal(contentKey: String): Int?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertContentKeyCounter(counter: ContentKeyCounterEntity)

    /**
     * Allocate the next ordinal for [contentKey]. Counters survive upload
     * deletes so a later identical SMS does not reuse ordinal 0 (M2).
     */
    @Transaction
    suspend fun allocateOrdinal(contentKey: String): Int {
        val next = getNextOrdinal(contentKey) ?: 0
        upsertContentKeyCounter(ContentKeyCounterEntity(contentKey, next + 1))
        return next
    }

    @Query(
        "SELECT * FROM queued_messages WHERE parked = 0 " +
            "AND nextAttemptAtEpochMs <= :nowEpochMs " +
            "ORDER BY createdAtEpochMs ASC LIMIT :limit",
    )
    suspend fun getReadyForUpload(nowEpochMs: Long, limit: Int = 100): List<QueuedMessageEntity>

    /** Earliest nextAttemptAt among non-parked rows, or null when the outbox is empty. */
    @Query("SELECT MIN(nextAttemptAtEpochMs) FROM queued_messages WHERE parked = 0")
    suspend fun earliestPendingAttemptAtEpochMs(): Long?

    @Query(
        "SELECT * FROM queued_messages WHERE parked = 0 " +
            "AND createdAtEpochMs < :cutoffEpochMs ORDER BY createdAtEpochMs ASC",
    )
    suspend fun getExpiredPending(cutoffEpochMs: Long): List<QueuedMessageEntity>

    @Query(
        "SELECT * FROM queued_messages WHERE parked = 0 " +
            "ORDER BY createdAtEpochMs ASC LIMIT :limit",
    )
    suspend fun getOldestPending(limit: Int): List<QueuedMessageEntity>

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(message: QueuedMessageEntity): Long

    @Query("DELETE FROM queued_messages WHERE deviceMsgId = :deviceMsgId")
    suspend fun deleteById(deviceMsgId: String)

    @Query("DELETE FROM queued_messages WHERE deviceMsgId IN (:deviceMsgIds)")
    suspend fun deleteByIds(deviceMsgIds: List<String>)

    @Query("DELETE FROM queued_messages")
    suspend fun deleteAll()

    @Query(
        "UPDATE queued_messages SET parked = 1, lastError = :error, " +
            "nextAttemptAtEpochMs = :nowEpochMs WHERE deviceMsgId = :deviceMsgId",
    )
    suspend fun park(deviceMsgId: String, error: String, nowEpochMs: Long)

    @Query(
        "UPDATE queued_messages SET attemptCount = attemptCount + 1, " +
            "nextAttemptAtEpochMs = :nextAttemptAtEpochMs, lastError = :error " +
            "WHERE deviceMsgId IN (:deviceMsgIds)",
    )
    suspend fun markRetry(
        deviceMsgIds: List<String>,
        nextAttemptAtEpochMs: Long,
        error: String?,
    )

    @Query(
        "UPDATE queued_messages SET parked = 0, nextAttemptAtEpochMs = :nowEpochMs, " +
            "lastError = NULL WHERE parked = 1",
    )
    suspend fun unparkAll(nowEpochMs: Long)
}
