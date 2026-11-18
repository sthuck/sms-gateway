package com.sthuck.smsgateway.upload

import com.sthuck.smsgateway.data.local.QueuedMessageDao
import com.sthuck.smsgateway.data.local.QueuedMessageEntity
import com.sthuck.smsgateway.data.remote.DeviceApi
import com.sthuck.smsgateway.data.remote.dto.BatchItemStatus
import com.sthuck.smsgateway.data.remote.dto.Problem
import com.sthuck.smsgateway.data.remote.dto.ProblemCodes
import com.sthuck.smsgateway.pairing.PairingCredentialsReader
import com.sthuck.smsgateway.pairing.PairingSession
import com.sthuck.smsgateway.sms.IncomingSmsMapper
import kotlinx.serialization.json.Json
import retrofit2.HttpException
import java.io.IOException
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.util.concurrent.ThreadLocalRandom
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.math.min
import kotlin.math.pow

/** Outcome of one uploader drain pass. */
sealed class UploadPassResult {
    data object NothingToDo : UploadPassResult()
    data object MorePending : UploadPassResult()
    data object Idle : UploadPassResult()
    data class RetryLater(val reason: String) : UploadPassResult()
    data class StopForRePair(val code: String) : UploadPassResult()
}

/**
 * Drains ready outbox rows via `POST /v1/messages:batch`.
 * Signing / clock-skew / credential wipe are handled by OkHttp interceptors.
 *
 * Request-level parking is reserved for explicit non-retryable 4xx problem
 * codes. Missing/unparsable bodies, 5xx/408/429, and `invalid_signature`
 * never park the batch (STH-49).
 */
@Singleton
class OutboxUploader @Inject constructor(
    private val dao: QueuedMessageDao,
    private val deviceApi: DeviceApi,
    private val credentialStore: PairingCredentialsReader,
    private val pairingSession: PairingSession,
    private val json: Json,
    private val housekeeping: OutboxHousekeeping,
) {
    suspend fun runOnce(nowEpochMs: Long = System.currentTimeMillis()): UploadPassResult {
        if (!credentialStore.current().isPaired) {
            return UploadPassResult.NothingToDo
        }

        housekeeping.enforceLimits(nowEpochMs)

        val ready = dao.getReadyForUpload(nowEpochMs, UploadDefaults.MAX_BATCH_MESSAGES)
        if (ready.isEmpty()) return UploadPassResult.Idle

        // Park oversized bodies locally (contract body_too_large) without a round-trip.
        val uploadable = mutableListOf<QueuedMessageEntity>()
        for (row in ready) {
            if (IncomingSmsMapper.unicodeLength(row.body) > UploadDefaults.MAX_BODY_CHARS) {
                dao.park(
                    deviceMsgId = row.deviceMsgId,
                    error = "body_too_large: body exceeds ${UploadDefaults.MAX_BODY_CHARS} Unicode characters",
                    nowEpochMs = nowEpochMs,
                )
            } else {
                uploadable += row
            }
        }
        if (uploadable.isEmpty()) {
            return if (dao.getReadyForUpload(nowEpochMs, 1).isNotEmpty()) {
                UploadPassResult.MorePending
            } else {
                UploadPassResult.Idle
            }
        }

        val pack = BatchPacker.pack(uploadable, json)
        if (pack.singleItemExceedsLimit) {
            val row = pack.rows.single()
            dao.park(
                deviceMsgId = row.deviceMsgId,
                error = "payload_too_large: single message JSON exceeds 1 MiB",
                nowEpochMs = nowEpochMs,
            )
            return UploadPassResult.MorePending
        }
        if (pack.rows.isEmpty()) return UploadPassResult.Idle

        return try {
            val response = deviceApi.ingestMessageBatch(pack.request)
            val byId = response.results.associateBy { it.deviceMsgId }
            val toDelete = mutableListOf<String>()
            for (row in pack.rows) {
                val item = byId[row.deviceMsgId]
                when (item?.status) {
                    BatchItemStatus.Accepted, BatchItemStatus.Duplicate -> {
                        toDelete += row.deviceMsgId
                    }
                    BatchItemStatus.Rejected -> {
                        val detail = item.error?.let { "${it.code}: ${it.detail}" }
                            ?: "rejected"
                        dao.park(row.deviceMsgId, detail, nowEpochMs)
                    }
                    null -> {
                        dao.markRetry(
                            deviceMsgIds = listOf(row.deviceMsgId),
                            nextAttemptAtEpochMs = nowEpochMs + backoffMs(row.attemptCount),
                            error = "missing_result",
                        )
                    }
                }
            }
            if (toDelete.isNotEmpty()) {
                dao.deleteByIds(toDelete)
            }
            if (dao.getReadyForUpload(nowEpochMs, 1).isNotEmpty()) {
                UploadPassResult.MorePending
            } else {
                UploadPassResult.Idle
            }
        } catch (e: HttpException) {
            handleHttp(e, pack.rows, nowEpochMs)
        } catch (_: IOException) {
            scheduleRetry(pack.rows, nowEpochMs, "network_error")
            UploadPassResult.RetryLater("network_error")
        } catch (e: Exception) {
            scheduleRetry(pack.rows, nowEpochMs, e.message ?: "upload_failed")
            UploadPassResult.RetryLater(e.message ?: "upload_failed")
        }
    }

    private suspend fun handleHttp(
        e: HttpException,
        rows: List<QueuedMessageEntity>,
        nowEpochMs: Long,
    ): UploadPassResult {
        val problem = parseProblem(e)
        val code = problem?.code
        when (code) {
            ProblemCodes.DEVICE_UNKNOWN,
            ProblemCodes.DEVICE_REVOKED,
            ProblemCodes.INVALID_SIGNATURE,
            -> {
                // Interceptor clears credentials for these; leave outbox pending
                // so a later re-pair can drain it (do not park).
                pairingSession.notifyRePairRequired()
                return UploadPassResult.StopForRePair(code)
            }
            ProblemCodes.INVALID_TIMESTAMP, ProblemCodes.REPLAY_DETECTED -> {
                scheduleRetry(rows, nowEpochMs, code, delayMs = 0L)
                return UploadPassResult.RetryLater(code)
            }
            ProblemCodes.PAYLOAD_TOO_LARGE, ProblemCodes.BATCH_TOO_LARGE -> {
                if (rows.size == 1) {
                    dao.park(
                        rows.single().deviceMsgId,
                        "$code: cannot split further",
                        nowEpochMs,
                    )
                    return UploadPassResult.MorePending
                }
                val half = rows.size / 2
                val first = BatchPacker.pack(rows.take(half.coerceAtLeast(1)), json)
                return tryUploadSubset(first.rows, nowEpochMs)
            }
            ProblemCodes.RATE_LIMITED -> {
                val delay = retryAfterDelayMs(e, nowEpochMs)
                    ?: backoffMs(rows.first().attemptCount)
                scheduleRetry(rows, nowEpochMs, code, delayMs = delay)
                return UploadPassResult.RetryLater(code)
            }
            ProblemCodes.INTERNAL_ERROR, ProblemCodes.SERVICE_UNAVAILABLE -> {
                val delay = retryAfterDelayMs(e, nowEpochMs)
                    ?: backoffMs(rows.minOf { it.attemptCount })
                val reason = code!!
                scheduleRetry(rows, nowEpochMs, reason, delayMs = delay)
                return UploadPassResult.RetryLater(reason)
            }
            else -> {
                if (shouldRetryHttp(e.code(), problem)) {
                    val reason = code ?: "http_${e.code()}"
                    val delay = retryAfterDelayMs(e, nowEpochMs)
                        ?: backoffMs(rows.minOf { it.attemptCount })
                    scheduleRetry(rows, nowEpochMs, reason, delayMs = delay)
                    return UploadPassResult.RetryLater(reason)
                }
                // Explicit non-retryable 4xx problem+json only.
                val detail = problem?.detail ?: problem?.title ?: "http_${e.code()}"
                for (row in rows) {
                    dao.park(
                        row.deviceMsgId,
                        "${code ?: "http_${e.code()}"}: $detail",
                        nowEpochMs,
                    )
                }
                return UploadPassResult.MorePending
            }
        }
    }

    private suspend fun tryUploadSubset(
        rows: List<QueuedMessageEntity>,
        nowEpochMs: Long,
    ): UploadPassResult {
        if (rows.isEmpty()) return UploadPassResult.Idle
        val pack = BatchPacker.pack(rows, json)
        return try {
            val response = deviceApi.ingestMessageBatch(pack.request)
            val byId = response.results.associateBy { it.deviceMsgId }
            val toDelete = mutableListOf<String>()
            for (row in pack.rows) {
                when (byId[row.deviceMsgId]?.status) {
                    BatchItemStatus.Accepted, BatchItemStatus.Duplicate -> toDelete += row.deviceMsgId
                    BatchItemStatus.Rejected -> {
                        val err = byId[row.deviceMsgId]?.error
                        dao.park(
                            row.deviceMsgId,
                            err?.let { "${it.code}: ${it.detail}" } ?: "rejected",
                            nowEpochMs,
                        )
                    }
                    null -> scheduleRetry(listOf(row), nowEpochMs, "missing_result")
                }
            }
            if (toDelete.isNotEmpty()) dao.deleteByIds(toDelete)
            UploadPassResult.MorePending
        } catch (e: HttpException) {
            handleHttp(e, pack.rows, nowEpochMs)
        } catch (_: IOException) {
            scheduleRetry(pack.rows, nowEpochMs, "network_error")
            UploadPassResult.RetryLater("network_error")
        }
    }

    private suspend fun scheduleRetry(
        rows: List<QueuedMessageEntity>,
        nowEpochMs: Long,
        error: String?,
        delayMs: Long? = null,
    ) {
        if (rows.isEmpty()) return
        val delay = delayMs ?: backoffMs(rows.minOf { it.attemptCount })
        dao.markRetry(
            deviceMsgIds = rows.map { it.deviceMsgId },
            nextAttemptAtEpochMs = nowEpochMs + delay,
            error = error,
        )
    }

    private fun parseProblem(e: HttpException): Problem? {
        val body = e.response()?.errorBody()?.string() ?: return null
        return runCatching { json.decodeFromString(Problem.serializer(), body) }.getOrNull()
    }

    companion object {
        /** Codes that permanently fail the whole request (park). */
        private val NON_RETRYABLE_REQUEST_CODES = setOf(
            ProblemCodes.INVALID_REQUEST,
            ProblemCodes.CONTENT_HASH_MISMATCH,
            ProblemCodes.BODY_TOO_LARGE,
        )

        /**
         * Retry when: 5xx / 408 / 429, missing/unparsable problem body, or
         * problem.retryable == true. Park only for an explicit non-retryable
         * 4xx problem code.
         */
        fun shouldRetryHttp(httpCode: Int, problem: Problem?): Boolean {
            if (httpCode in 500..599 || httpCode == 408 || httpCode == 429) return true
            if (problem == null) return true
            if (problem.retryable) return true
            if (problem.code in NON_RETRYABLE_REQUEST_CODES) return false
            // Unknown non-retryable 4xx with a parsed problem → park.
            return httpCode !in 400..499
        }

        /**
         * Parses `Retry-After` as delta-seconds or HTTP-date (RFC 9110).
         * Returns delay from [nowEpochMs]; null when the header is absent/unparsable.
         */
        fun retryAfterDelayMs(
            e: HttpException,
            nowEpochMs: Long = System.currentTimeMillis(),
        ): Long? {
            val raw = e.response()?.headers()?.get("Retry-After")?.trim().orEmpty()
            if (raw.isEmpty()) return null
            raw.toLongOrNull()?.let { return it.coerceAtLeast(0L) * 1000L }
            return runCatching {
                val instant = Instant.from(DateTimeFormatter.RFC_1123_DATE_TIME.parse(raw))
                (instant.toEpochMilli() - nowEpochMs).coerceAtLeast(0L)
            }.getOrNull()
        }

        /** Full-jitter exponential backoff from 15s, capped at 15m (contract). */
        fun backoffMs(attemptCount: Int): Long {
            val exp = min(attemptCount, 6)
            val base = (15_000.0 * 2.0.pow(exp.toDouble())).toLong()
            val capped = min(base, UploadDefaults.MAX_RETRY_DELAY_MS)
            if (capped <= 0L) return 0L
            return ThreadLocalRandom.current().nextLong(capped + 1)
        }
    }
}
