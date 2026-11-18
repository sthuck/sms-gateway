package com.sthuck.smsgateway.upload

import androidx.work.ExistingWorkPolicy
import org.junit.Assert.assertEquals
import org.junit.Test

class UploadSchedulerPolicyTest {

    @Test
    fun delayZeroUsesReplaceSoNewSmsIsNotBehindBackoff() {
        assertEquals(ExistingWorkPolicy.REPLACE, UploadScheduler.policyForDelay(0L))
        assertEquals(ExistingWorkPolicy.APPEND_OR_REPLACE, UploadScheduler.policyForDelay(15_000L))
    }
}
