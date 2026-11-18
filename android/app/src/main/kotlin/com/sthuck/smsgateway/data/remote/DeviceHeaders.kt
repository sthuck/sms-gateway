package com.sthuck.smsgateway.data.remote

/**
 * ES256 request-signing headers from the STH-5 device API contract.
 * Applied by [RequestSigningInterceptor].
 */
object DeviceHeaders {
    const val DEVICE_ID = "X-Device-Id"
    const val TIMESTAMP = "X-Timestamp"
    const val NONCE = "X-Nonce"
    const val CONTENT_SHA256 = "X-Content-SHA256"
    const val SIGNATURE = "X-Signature"

    /** SHA-256 of an empty body, required on GET /v1/devices/me. */
    const val EMPTY_BODY_SHA256 =
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
}
