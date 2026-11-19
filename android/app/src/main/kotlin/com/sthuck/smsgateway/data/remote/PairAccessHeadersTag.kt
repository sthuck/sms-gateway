package com.sthuck.smsgateway.data.remote

/**
 * Per-call Retrofit `@Tag` carrying candidate access headers for `POST /v1/devices/pair`.
 * Scoped strictly to [serverOrigin] so headers are never sent to another host.
 */
data class PairAccessHeadersTag(
    val serverOrigin: String,
    val headers: Map<String, String>,
)
