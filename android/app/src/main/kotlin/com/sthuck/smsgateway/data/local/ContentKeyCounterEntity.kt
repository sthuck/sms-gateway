package com.sthuck.smsgateway.data.local

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Survives upload deletes so [IncomingSmsEnqueuer] can allocate a stable
 * increasing ordinal per [contentKey] (M2). Without this, a second genuine
 * identical SMS after the first was accepted would reuse ordinal 0, get
 * `duplicate` from the backend, and be dropped.
 */
@Entity(tableName = "content_key_counters")
data class ContentKeyCounterEntity(
    @PrimaryKey val contentKey: String,
    /** Next ordinal to assign (0-based). */
    val nextOrdinal: Int,
)
