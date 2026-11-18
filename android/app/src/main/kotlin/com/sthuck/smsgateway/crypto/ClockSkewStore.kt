package com.sthuck.smsgateway.crypto

import java.util.concurrent.atomic.AtomicLong
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Holds `server_time - local_time` so re-signed requests after
 * `401 invalid_timestamp` land inside the ±300s window.
 */
@Singleton
class ClockSkewStore @Inject constructor() {
    private val offsetSeconds = AtomicLong(0)

    fun nowUnixSeconds(): Long =
        (System.currentTimeMillis() / 1000L) + offsetSeconds.get()

    fun applyServerTime(serverUnixSeconds: Long) {
        val local = System.currentTimeMillis() / 1000L
        offsetSeconds.set(serverUnixSeconds - local)
    }

    fun clear() {
        offsetSeconds.set(0)
    }
}
