package com.sthuck.smsgateway.pairing

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import javax.inject.Inject
import javax.inject.Singleton

/** Signals UI to return to the pairing screen after credential wipe. */
@Singleton
class PairingSession @Inject constructor() {
    private val _rePairRequired = MutableSharedFlow<RePairReason>(extraBufferCapacity = 1)
    val rePairRequired: SharedFlow<RePairReason> = _rePairRequired.asSharedFlow()

    fun notifyRePairRequired(reason: RePairReason = RePairReason.OTHER) {
        _rePairRequired.tryEmit(reason)
    }
}
