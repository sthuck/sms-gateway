package com.sthuck.smsgateway.data.remote.dto

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class DeviceStatusValue {
    @SerialName("active")
    Active,

    @SerialName("revoked")
    Revoked,
}

@Serializable
enum class Direction {
    @SerialName("inbound")
    Inbound,

    @SerialName("outbound")
    Outbound,
}

@Serializable
enum class BatchItemStatus {
    @SerialName("accepted")
    Accepted,

    @SerialName("duplicate")
    Duplicate,

    @SerialName("rejected")
    Rejected,
}

@Serializable
data class DeviceInfo(
    val platform: String = "android",
    val appVersion: String,
    val name: String? = null,
    val manufacturer: String? = null,
    val model: String? = null,
    val osVersion: String? = null,
    val sdkInt: Int? = null,
)

@Serializable
data class PairRequest(
    val pairingCode: String,
    val alg: String = "ES256",
    val publicKey: String,
    val deviceInfo: DeviceInfo,
)

@Serializable
data class PairResponse(
    val deviceId: String,
    val name: String,
    val status: DeviceStatusValue,
    val pairedAt: String,
)

@Serializable
data class DeviceStatus(
    val deviceId: String,
    val name: String,
    val status: DeviceStatusValue,
    val pairedAt: String,
    val lastSeenAt: String,
    val revokedAt: String? = null,
)

/**
 * Per-message body cap from STH-5 v1 draft 2 (`maxLength: 32768`).
 * Packing/rejection against this limit is done by the uploader (STH-13);
 * the OpenAPI mock and backend enforce it as `body_too_large`.
 */
const val DEVICE_MESSAGE_BODY_MAX_CHARS = 32_768

@Serializable
data class DeviceMessage(
    val deviceMsgId: String,
    val sender: String,
    val body: String,
    val receivedAt: String,
    val direction: Direction,
    val simSlot: Int? = null,
)

@Serializable
data class MessageBatchRequest(
    val messages: List<DeviceMessage>,
)

@Serializable
data class ItemError(
    val code: String,
    val detail: String,
)

@Serializable
data class BatchItemResult(
    val deviceMsgId: String,
    val status: BatchItemStatus,
    val id: String? = null,
    val error: ItemError? = null,
)

@Serializable
data class MessageBatchResponse(
    val results: List<BatchItemResult>,
)

/** RFC 9457 problem+json with the STH-5 `code` and `retryable` fields. */
@Serializable
data class Problem(
    val type: String,
    val title: String,
    val status: Int,
    val code: String,
    val retryable: Boolean,
    val detail: String? = null,
    val instance: String? = null,
    /**
     * Server UTC time as Unix seconds. Present on `401 invalid_timestamp`
     * (draft 2) so the client can compute a clock offset and re-sign.
     * Absent on other problem responses.
     */
    val serverTime: Long? = null,
)

/** Stable machine-readable problem codes from STH-5 v1 draft 2. */
object ProblemCodes {
    const val INVALID_REQUEST = "invalid_request"
    const val CONTENT_HASH_MISMATCH = "content_hash_mismatch"
    const val INVALID_PAIRING_CODE = "invalid_pairing_code"
    const val INVALID_PUBLIC_KEY = "invalid_public_key"
    const val INVALID_SIGNATURE = "invalid_signature"
    const val INVALID_TIMESTAMP = "invalid_timestamp"
    const val REPLAY_DETECTED = "replay_detected"
    const val DEVICE_UNKNOWN = "device_unknown"
    const val DEVICE_REVOKED = "device_revoked"
    const val PAYLOAD_TOO_LARGE = "payload_too_large"
    const val BATCH_TOO_LARGE = "batch_too_large"
    const val RATE_LIMITED = "rate_limited"
    const val INTERNAL_ERROR = "internal_error"
    const val SERVICE_UNAVAILABLE = "service_unavailable"
    const val BODY_TOO_LARGE = "body_too_large"
}

