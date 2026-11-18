package com.sthuck.smsgateway.sms

import org.junit.Assert.assertEquals
import org.junit.Test

class SmsPermissionStateTest {

    @Test
    fun grantedWhenBothPermissionsAreGranted() {
        assertEquals(
            SmsPermissionState.Granted,
            smsPermissionState(
                SmsPermissionSnapshot(
                    receiveGranted = true,
                    readGranted = true,
                    receiveShouldShowRationale = false,
                    readShouldShowRationale = false,
                    hasRequestedBefore = true,
                ),
            ),
        )
    }

    @Test
    fun notRequestedUntilThePromptHasBeenShown() {
        assertEquals(
            SmsPermissionState.NotRequested,
            smsPermissionState(
                SmsPermissionSnapshot(
                    receiveGranted = false,
                    readGranted = false,
                    receiveShouldShowRationale = false,
                    readShouldShowRationale = false,
                    hasRequestedBefore = false,
                ),
            ),
        )
    }

    @Test
    fun deniedWhenTheSystemWillShowARationaleAgain() {
        assertEquals(
            SmsPermissionState.Denied,
            smsPermissionState(
                SmsPermissionSnapshot(
                    receiveGranted = false,
                    readGranted = false,
                    receiveShouldShowRationale = true,
                    readShouldShowRationale = true,
                    hasRequestedBefore = true,
                ),
            ),
        )
    }

    @Test
    fun permanentlyDeniedAfterDontAskAgainOrSettingsRevocation() {
        assertEquals(
            SmsPermissionState.PermanentlyDenied,
            smsPermissionState(
                SmsPermissionSnapshot(
                    receiveGranted = false,
                    readGranted = false,
                    receiveShouldShowRationale = false,
                    readShouldShowRationale = false,
                    hasRequestedBefore = true,
                ),
            ),
        )
    }

    @Test
    fun notFullyGrantedIfOnlyOnePermissionIsGranted() {
        assertEquals(
            SmsPermissionState.Denied,
            smsPermissionState(
                SmsPermissionSnapshot(
                    receiveGranted = true,
                    readGranted = false,
                    receiveShouldShowRationale = false,
                    readShouldShowRationale = true,
                    hasRequestedBefore = true,
                ),
            ),
        )
    }
}
