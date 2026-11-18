package com.sthuck.smsgateway.upload

/**
 * Defaults for the STH-13 outbox uploader. Override via constructor /
 * WorkManager input data later if needed; documented here for operators.
 */
object UploadDefaults {
    /** Contract draft-2 max messages per `POST /v1/messages:batch`. */
    const val MAX_BATCH_MESSAGES = 100

    /** Contract draft-2 max raw request body size (1 MiB). */
    const val MAX_BATCH_BODY_BYTES = 1_048_576

    /** Per-message Unicode body cap (`DEVICE_MESSAGE_BODY_MAX_CHARS`). */
    const val MAX_BODY_CHARS = 32_768

    /** WorkManager exponential backoff initial delay (contract suggests 15s). */
    const val BACKOFF_INITIAL_SECONDS = 15L

    /** Cap for local next-attempt scheduling after 5xx (15 minutes). */
    const val MAX_RETRY_DELAY_MS = 15L * 60L * 1000L

    const val UNIQUE_WORK_NAME = "sms_gateway_message_upload"
}
