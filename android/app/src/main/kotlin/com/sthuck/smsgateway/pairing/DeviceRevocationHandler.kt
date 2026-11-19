package com.sthuck.smsgateway.pairing

import com.sthuck.smsgateway.crypto.ClockSkewStore
import com.sthuck.smsgateway.crypto.DeviceKeyAccess
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Wipes pairing credentials after a *genuine* revocation / unknown-device
 * signal. Must not be called for `invalid_signature` or transient errors —
 * those leave the outbox pending and keep the Keystore key (STH-18).
 */
@Singleton
class DeviceRevocationHandler @Inject constructor(
    private val credentialStore: PairingStateAccess,
    private val deviceKeyStore: DeviceKeyAccess,
    private val clockSkewStore: ClockSkewStore,
    private val pairingSession: PairingSession,
) {
    suspend fun wipeAndPromptRePair(reason: RePairReason) {
        credentialStore.clearDeviceId()
        deviceKeyStore.deleteKey()
        clockSkewStore.clear()
        pairingSession.notifyRePairRequired(reason)
    }
}
