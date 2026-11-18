package com.sthuck.smsgateway.sms

/**
 * Combined state of `RECEIVE_SMS` and `READ_SMS`.
 * Both must be granted before the receiver and a later backfill can work.
 */
enum class SmsPermissionState {
    NotRequested,
    Denied,
    PermanentlyDenied,
    Granted,
}

data class SmsPermissionSnapshot(
    val receiveGranted: Boolean,
    val readGranted: Boolean,
    val receiveShouldShowRationale: Boolean,
    val readShouldShowRationale: Boolean,
    val hasRequestedBefore: Boolean,
) {
    val allGranted: Boolean get() = receiveGranted && readGranted
}

fun smsPermissionState(snapshot: SmsPermissionSnapshot): SmsPermissionState {
    if (snapshot.allGranted) return SmsPermissionState.Granted
    if (!snapshot.hasRequestedBefore) return SmsPermissionState.NotRequested
    val canAskAgain =
        (!snapshot.receiveGranted && snapshot.receiveShouldShowRationale) ||
            (!snapshot.readGranted && snapshot.readShouldShowRationale)
    return if (canAskAgain) {
        SmsPermissionState.Denied
    } else {
        SmsPermissionState.PermanentlyDenied
    }
}
