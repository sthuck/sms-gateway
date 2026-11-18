package com.sthuck.smsgateway.data.local

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

@Dao
interface QueuedMessageDao {
    @Query("SELECT * FROM queued_messages ORDER BY createdAtEpochMs ASC")
    suspend fun getAll(): List<QueuedMessageEntity>

    @Query("SELECT COUNT(*) FROM queued_messages")
    fun observeCount(): Flow<Int>

    @Query("SELECT * FROM queued_messages ORDER BY createdAtEpochMs DESC LIMIT :limit")
    fun observeRecent(limit: Int = 5): Flow<List<QueuedMessageEntity>>

    @Query("SELECT COUNT(*) FROM queued_messages WHERE contentKey = :contentKey")
    suspend fun countByContentKey(contentKey: String): Int

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(message: QueuedMessageEntity): Long

    @Query("DELETE FROM queued_messages WHERE deviceMsgId = :deviceMsgId")
    suspend fun deleteById(deviceMsgId: String)

    @Query("DELETE FROM queued_messages")
    suspend fun deleteAll()
}
