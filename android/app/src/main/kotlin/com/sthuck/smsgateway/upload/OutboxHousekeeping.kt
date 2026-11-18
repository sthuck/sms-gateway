package com.sthuck.smsgateway.upload

import com.sthuck.smsgateway.data.local.QueuedMessageDao
import javax.inject.Inject
import javax.inject.Singleton

data class HousekeepingResult(
    val expiredParked: Int,
    val overCapParked: Int,
)

/**
 * Bounds the outbox by TTL and row cap. Parks (never silently deletes) so
 * the status screen can show [UploadDefaults.PARK_REASON_EXPIRED_TTL] /
 * [UploadDefaults.PARK_REASON_OVER_CAP] in `lastError`.
 */
@Singleton
class OutboxHousekeeping @Inject constructor(
    private val dao: QueuedMessageDao,
) {
    suspend fun enforceLimits(
        nowEpochMs: Long = System.currentTimeMillis(),
        maxRows: Int = UploadDefaults.MAX_OUTBOX_ROWS,
        ttlMs: Long = UploadDefaults.OUTBOX_TTL_MS,
    ): HousekeepingResult {
        var expired = 0
        val cutoff = nowEpochMs - ttlMs
        for (row in dao.getExpiredPending(cutoff)) {
            dao.park(
                deviceMsgId = row.deviceMsgId,
                error = "${UploadDefaults.PARK_REASON_EXPIRED_TTL}: older than outbox TTL",
                nowEpochMs = nowEpochMs,
            )
            expired++
        }

        // Cap applies to pending (uploadable) rows. Parked rows stay visible on
        // the status screen until the user retries or clears them.
        var overCap = 0
        var pending = dao.countPending()
        while (pending > maxRows) {
            val oldest = dao.getOldestPending(limit = 1).singleOrNull() ?: break
            dao.park(
                deviceMsgId = oldest.deviceMsgId,
                error = "${UploadDefaults.PARK_REASON_OVER_CAP}: pending outbox exceeds $maxRows rows",
                nowEpochMs = nowEpochMs,
            )
            overCap++
            pending = dao.countPending()
        }
        return HousekeepingResult(expiredParked = expired, overCapParked = overCap)
    }
}
