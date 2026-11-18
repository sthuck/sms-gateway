package com.sthuck.smsgateway.keepalive

/**
 * Result of one heartbeat attempt. Never feeds the outbox park/retry path.
 */
sealed class HeartbeatOutcome {
    /** [BuildConfig.HEARTBEAT_ENABLED] is false; no network call. */
    data object Disabled : HeartbeatOutcome()

    data object Ok : HeartbeatOutcome()

    /** 404, 5xx, or transport errors — ignore and try later. */
    data object RetryableIgnored : HeartbeatOutcome()

    /** Other HTTP statuses; still must not affect uploads. */
    data class NonBlockingFailure(val httpCode: Int) : HeartbeatOutcome()
}

object HeartbeatPolicy {
    fun fromHttpCode(code: Int): HeartbeatOutcome = when {
        code in 200..299 -> HeartbeatOutcome.Ok
        code == 404 || code in 500..599 -> HeartbeatOutcome.RetryableIgnored
        else -> HeartbeatOutcome.NonBlockingFailure(code)
    }
}
