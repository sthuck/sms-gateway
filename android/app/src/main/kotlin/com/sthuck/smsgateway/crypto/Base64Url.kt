package com.sthuck.smsgateway.crypto

import java.util.Base64

/** Unpadded base64url (RFC 4648 §5) helpers for the STH-5 signing scheme. */
object Base64Url {
    fun encode(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun decode(value: String): ByteArray =
        Base64.getUrlDecoder().decode(value)
}
