package com.sthuck.smsgateway.crypto

/**
 * Builds the nine-field STH-5 canonical string (UTF-8, `\n`-joined, no
 * trailing newline after NONCE). See `docs/contracts/device-signing.md`.
 */
object CanonicalString {
    fun build(
        method: String,
        path: String,
        query: String,
        host: String,
        deviceId: String,
        timestamp: String,
        contentSha256: String,
        nonce: String,
    ): String = listOf(
        "v1",
        method.uppercase(),
        path,
        query,
        host.lowercase(),
        deviceId,
        timestamp,
        contentSha256.lowercase(),
        nonce,
    ).joinToString("\n")
}
