package com.sthuck.smsgateway.upload

/**
 * Defaults for the outbox uploader and retention. Documented for operators;
 * see `docs/android-outbox-retention.md`.
 */
object UploadDefaults {
    /** Contract draft-2 max messages per `POST /v1/messages:batch`. */
    const val MAX_BATCH_MESSAGES = 100

    /** Contract draft-2 max raw request body size (1 MiB). */
    const val MAX_BATCH_BODY_BYTES = 1_048_576

    /** Per-message Unicode body cap (`DEVICE_MESSAGE_BODY_MAX_CHARS`). */
    const val MAX_BODY_CHARS = 32_768

    /** Contract max sender length (Unicode code points). */
    const val MAX_SENDER_CHARS = 64

    /** Contract max sim_slot (inclusive). */
    const val MAX_SIM_SLOT = 9

    /** WorkManager exponential backoff initial delay (contract suggests 15s). */
    const val BACKOFF_INITIAL_SECONDS = 15L

    /** Cap for local next-attempt scheduling after 5xx (15 minutes). */
    const val MAX_RETRY_DELAY_MS = 15L * 60L * 1000L

    /**
     * Soft cap on **pending** outbox rows. Oldest pending rows are parked with
     * `over_cap` when exceeded — never deleted silently (parked stay visible).
     */
    const val MAX_OUTBOX_ROWS = 2_000

    /** Park (do not delete) pending rows older than this TTL. */
    const val OUTBOX_TTL_MS = 7L * 24L * 60L * 60L * 1000L

    const val UNIQUE_WORK_NAME = "sms_gateway_message_upload"

    const val PARK_REASON_EXPIRED_TTL = "expired_ttl"
    const val PARK_REASON_OVER_CAP = "over_cap"
}
