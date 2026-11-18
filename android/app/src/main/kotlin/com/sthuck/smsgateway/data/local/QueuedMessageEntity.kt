package com.sthuck.smsgateway.data.local

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Local outbox row drained by [com.sthuck.smsgateway.upload.MessageUploadWorker].
 *
 * [deviceMsgId] is the unique idempotency key. Inserting a row with an
 * existing id is a no-op ([OnConflictStrategy.IGNORE] in the DAO).
 *
 * Uploader columns (STH-13 / schema v3):
 * - [attemptCount] / [nextAttemptAtEpochMs] drive retry scheduling
 * - [lastError] holds the last RFC 9457 / per-item detail (also for parked)
 * - [parked] marks non-retryable failures that stay visible until unpair/clear
 */
@Entity(
    tableName = "queued_messages",
    indices = [
        Index(value = ["contentKey"]),
        Index(value = ["parked", "nextAttemptAtEpochMs"]),
    ],
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
    val attemptCount: Int = 0,
    val nextAttemptAtEpochMs: Long = 0L,
    val lastError: String? = null,
    val parked: Boolean = false,
)
