package com.sthuck.smsgateway.crypto

import java.util.Base64

/** Unpadded base64url (RFC 4648 §5) helpers for the STH-5 signing scheme. */
object Base64Url {
    fun encode(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    fun decode(input: String): ByteArray {
        require(input.isNotEmpty()) { "Base64url input must not be empty" }
        require(input.length % 4 != 1) { "Invalid base64url length" }
        for (ch in input) {
            val valid = (ch in 'A'..'Z') ||
                (ch in 'a'..'z') ||
                (ch in '0'..'9') ||
                ch == '-' ||
                ch == '_'
            require(valid) { "Invalid base64url character" }
        }
        return Base64.getUrlDecoder().decode(input)
    }
}
