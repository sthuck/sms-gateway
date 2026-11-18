package com.sthuck.smsgateway.keepalive

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HeartbeatPolicyTest {

    @Test
    fun successCodesAreOk() {
        assertEquals(HeartbeatOutcome.Ok, HeartbeatPolicy.fromHttpCode(200))
        assertEquals(HeartbeatOutcome.Ok, HeartbeatPolicy.fromHttpCode(204))
    }

    @Test
    fun notFoundAndServerErrorsAreRetryableIgnored() {
        assertEquals(HeartbeatOutcome.RetryableIgnored, HeartbeatPolicy.fromHttpCode(404))
        assertEquals(HeartbeatOutcome.RetryableIgnored, HeartbeatPolicy.fromHttpCode(500))
        assertEquals(HeartbeatOutcome.RetryableIgnored, HeartbeatPolicy.fromHttpCode(503))
    }

    @Test
    fun otherFailuresAreNonBlocking() {
        val outcome = HeartbeatPolicy.fromHttpCode(401)
        assertTrue(outcome is HeartbeatOutcome.NonBlockingFailure)
        assertEquals(401, (outcome as HeartbeatOutcome.NonBlockingFailure).httpCode)
    }
}
