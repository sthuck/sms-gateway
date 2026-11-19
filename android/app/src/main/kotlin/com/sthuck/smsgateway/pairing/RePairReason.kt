package com.sthuck.smsgateway.pairing

/** Why the UI should return to the pairing screen after credentials were cleared. */
enum class RePairReason {
    /** Server reported the device as revoked (problem code or GET /v1/devices/me). */
    REVOKED,

    /** Server no longer knows this device id. */
    UNKNOWN,

    /** Paired device id exists but the Keystore signing key is missing. */
    KEY_MISSING,

    /** Generic re-pair (manual unpair path does not use this signal). */
    OTHER,
}
