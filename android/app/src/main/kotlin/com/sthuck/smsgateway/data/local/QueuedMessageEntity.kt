package com.sthuck.smsgateway.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Local outbox row. WorkManager upload (STH-13) will drain this table.
 *
 * [deviceMsgId] is the unique idempotency key. Inserting a row with an
 * existing id is a no-op ([OnConflictStrategy.IGNORE] in the DAO).
 */
@Entity(
    tableName = "queued_messages",
    indices = [Index(value = ["contentKey"])],
)
data class QueuedMessageEntity(
    @PrimaryKey val deviceMsgId: String,
    val contentKey: String,
    val sender: String,
    val body: String,
    val receivedAt: String,
    val direction: String,
    val simSlot: Int? = null,
    val createdAtEpochMs: Long,
)
