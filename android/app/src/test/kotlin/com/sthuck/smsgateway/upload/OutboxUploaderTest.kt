package com.sthuck.smsgateway.upload

import com.sthuck.smsgateway.data.local.ContentKeyCounterEntity
import com.sthuck.smsgateway.data.local.QueuedMessageDao
import com.sthuck.smsgateway.data.local.QueuedMessageEntity
import com.sthuck.smsgateway.data.remote.DeviceApi
import com.sthuck.smsgateway.data.remote.dto.ProblemCodes
import com.sthuck.smsgateway.pairing.PairingCredentials
import com.sthuck.smsgateway.pairing.PairingCredentialsReader
import com.sthuck.smsgateway.pairing.PairingSession
import com.sthuck.smsgateway.testing.DeviceApiMock
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

class OutboxUploaderTest {

    private lateinit var server: MockWebServer
    private lateinit var dao: FakeDao
    private lateinit var uploader: OutboxUploader
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        namingStrategy = JsonNamingStrategy.SnakeCase
    }

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        dao = FakeDao()
        val credentials = PairingCredentialsReader {
            PairingCredentials(DeviceApiMock.SAMPLE_DEVICE_ID, server.url("/").toString())
        }
        val api = Retrofit.Builder()
            .baseUrl(server.url("/"))
            .client(OkHttpClient())
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(DeviceApi::class.java)
        uploader = OutboxUploader(dao, api, credentials, PairingSession(), json, OutboxHousekeeping(dao))
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun acceptedDeletesRow() = runBlocking {
        dao.rows += sample("sms-42")
        DeviceApiMock.enqueueBatchAccepted(server, deviceMsgId = "sms-42")

        val result = uploader.runOnce(nowEpochMs = 1_000L)
        assertTrue(result is UploadPassResult.Idle)
        assertTrue(dao.rows.none { it.deviceMsgId == "sms-42" })
    }

    @Test
    fun rejectedParksRow() = runBlocking {
        dao.rows += sample("sms-bad")
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody(
                    """
                    {
                      "results":[{
                        "device_msg_id":"sms-bad",
                        "status":"rejected",
                        "error":{"code":"invalid_field","detail":"bad sender"}
                      }]
                    }
                    """.trimIndent(),
                )
                .addHeader("Content-Type", "application/json"),
        )

        uploader.runOnce(nowEpochMs = 1_000L)
        val parked = dao.rows.single()
        assertTrue(parked.parked)
        assertTrue(parked.lastError!!.contains("invalid_field"))
    }

    @Test
    fun oversizedBodyParkedLocallyWithoutNetwork() = runBlocking {
        dao.rows += sample("sms-huge", body = "x".repeat(UploadDefaults.MAX_BODY_CHARS + 1))
        uploader.runOnce(nowEpochMs = 1_000L)
        assertEquals(0, server.requestCount)
        assertTrue(dao.rows.single().parked)
        assertTrue(dao.rows.single().lastError!!.contains("body_too_large"))
    }

    @Test
    fun deviceRevokedStopsUploader() = runBlocking {
        dao.rows += sample("sms-1")
        DeviceApiMock.enqueueProblem(
            server,
            httpCode = 403,
            code = ProblemCodes.DEVICE_REVOKED,
            title = "revoked",
            detail = "gone",
            retryable = false,
        )
        val result = uploader.runOnce(nowEpochMs = 1_000L)
        assertTrue(result is UploadPassResult.StopForRePair)
        assertEquals(ProblemCodes.DEVICE_REVOKED, (result as UploadPassResult.StopForRePair).code)
        assertEquals(1, dao.rows.size)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun deviceUnknownStopsUploader() = runBlocking {
        dao.rows += sample("sms-1")
        DeviceApiMock.enqueueProblem(
            server,
            httpCode = 401,
            code = ProblemCodes.DEVICE_UNKNOWN,
            title = "unknown",
            detail = "gone",
            retryable = false,
        )
        val result = uploader.runOnce(nowEpochMs = 1_000L)
        assertTrue(result is UploadPassResult.StopForRePair)
        assertEquals(ProblemCodes.DEVICE_UNKNOWN, (result as UploadPassResult.StopForRePair).code)
    }

    @Test
    fun retryableServerErrorSchedulesRetry() = runBlocking {
        dao.rows += sample("sms-1")
        DeviceApiMock.enqueueProblem(
            server,
            httpCode = 503,
            code = ProblemCodes.SERVICE_UNAVAILABLE,
            title = "unavailable",
            detail = "try later",
            retryable = true,
        )
        val result = uploader.runOnce(nowEpochMs = 1_000L)
        assertTrue(result is UploadPassResult.RetryLater)
        val row = dao.rows.single()
        assertEquals(1, row.attemptCount)
        assertTrue(row.nextAttemptAtEpochMs >= 1_000L)
        assertTrue(!row.parked)
    }

    @Test
    fun html502DoesNotParkAndRetries() = runBlocking {
        dao.rows += sample("sms-1")
        server.enqueue(
            MockResponse()
                .setResponseCode(502)
                .setBody("<html>Bad Gateway</html>")
                .addHeader("Content-Type", "text/html"),
        )
        val result = uploader.runOnce(nowEpochMs = 1_000L)
        assertTrue(result is UploadPassResult.RetryLater)
        val row = dao.rows.single()
        assertTrue(!row.parked)
        assertEquals(1, row.attemptCount)
    }

    @Test
    fun empty404BodyDoesNotParkAndRetries() = runBlocking {
        dao.rows += sample("sms-1")
        server.enqueue(MockResponse().setResponseCode(404).setBody(""))
        val result = uploader.runOnce(nowEpochMs = 1_000L)
        assertTrue(result is UploadPassResult.RetryLater)
        assertTrue(!dao.rows.single().parked)
    }

    @Test
    fun empty500BodyDoesNotParkAndRetries() = runBlocking {
        dao.rows += sample("sms-1")
        server.enqueue(MockResponse().setResponseCode(500).setBody(""))
        val result = uploader.runOnce(nowEpochMs = 1_000L)
        assertTrue(result is UploadPassResult.RetryLater)
        assertTrue(!dao.rows.single().parked)
        assertEquals(1, dao.rows.single().attemptCount)
    }

    @Test
    fun replayDetectedSchedulesImmediateRetry() = runBlocking {
        dao.rows += sample("sms-1")
        DeviceApiMock.enqueueProblem(
            server,
            httpCode = 401,
            code = ProblemCodes.REPLAY_DETECTED,
            title = "replay",
            detail = "nonce",
            retryable = true,
        )
        val result = uploader.runOnce(nowEpochMs = 1_000L)
        assertTrue(result is UploadPassResult.RetryLater)
        assertEquals(ProblemCodes.REPLAY_DETECTED, (result as UploadPassResult.RetryLater).reason)
        assertEquals(1_000L, dao.rows.single().nextAttemptAtEpochMs)
        assertTrue(!dao.rows.single().parked)
    }

    @Test
    fun invalidTimestampSchedulesImmediateRetry() = runBlocking {
        dao.rows += sample("sms-1")
        DeviceApiMock.enqueueProblem(
            server,
            httpCode = 401,
            code = ProblemCodes.INVALID_TIMESTAMP,
            title = "skew",
            detail = "window",
            retryable = true,
            serverTime = 1_794_995_160L,
        )
        val result = uploader.runOnce(nowEpochMs = 2_000L)
        assertTrue(result is UploadPassResult.RetryLater)
        assertEquals(ProblemCodes.INVALID_TIMESTAMP, (result as UploadPassResult.RetryLater).reason)
        assertEquals(2_000L, dao.rows.single().nextAttemptAtEpochMs)
        assertTrue(!dao.rows.single().parked)
    }

    @Test
    fun rateLimitedHonoursRetryAfter() = runBlocking {
        dao.rows += sample("sms-1")
        server.enqueue(
            MockResponse()
                .setResponseCode(429)
                .setBody(
                    """
                    {
                      "type":"about:blank",
                      "title":"rate",
                      "status":429,
                      "code":"rate_limited",
                      "retryable":true,
                      "detail":"slow down"
                    }
                    """.trimIndent(),
                )
                .addHeader("Content-Type", "application/problem+json")
                .addHeader("Retry-After", "30"),
        )
        val result = uploader.runOnce(nowEpochMs = 1_000L)
        assertTrue(result is UploadPassResult.RetryLater)
        assertEquals(1_000L + 30_000L, dao.rows.single().nextAttemptAtEpochMs)
        assertTrue(!dao.rows.single().parked)
    }

    @Test
    fun serviceUnavailableHonoursRetryAfter() = runBlocking {
        dao.rows += sample("sms-1")
        server.enqueue(
            MockResponse()
                .setResponseCode(503)
                .setBody(
                    """
                    {
                      "type":"about:blank",
                      "title":"unavailable",
                      "status":503,
                      "code":"service_unavailable",
                      "retryable":true,
                      "detail":"try later"
                    }
                    """.trimIndent(),
                )
                .addHeader("Content-Type", "application/problem+json")
                .addHeader("Retry-After", "12"),
        )
        val result = uploader.runOnce(nowEpochMs = 5_000L)
        assertTrue(result is UploadPassResult.RetryLater)
        assertEquals(5_000L + 12_000L, dao.rows.single().nextAttemptAtEpochMs)
    }

    @Test
    fun retryAfterHttpDateIsHonoured() = runBlocking {
        dao.rows += sample("sms-1")
        val now = 1_000_000L
        val httpDate = java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME
            .withZone(java.time.ZoneOffset.UTC)
            .format(java.time.Instant.ofEpochMilli(now + 45_000L))
        server.enqueue(
            MockResponse()
                .setResponseCode(503)
                .setBody(
                    """
                    {
                      "type":"about:blank",
                      "title":"unavailable",
                      "status":503,
                      "code":"service_unavailable",
                      "retryable":true,
                      "detail":"try later"
                    }
                    """.trimIndent(),
                )
                .addHeader("Content-Type", "application/problem+json")
                .addHeader("Retry-After", httpDate),
        )
        uploader.runOnce(nowEpochMs = now)
        assertEquals(now + 45_000L, dao.rows.single().nextAttemptAtEpochMs)
    }

    @Test
    fun batchTooLargeSplitsAndUploadsSubset() = runBlocking {
        dao.rows += sample("sms-a")
        dao.rows += sample("sms-b")
        DeviceApiMock.enqueueProblem(
            server,
            httpCode = 413,
            code = ProblemCodes.BATCH_TOO_LARGE,
            title = "too big",
            detail = "split",
            retryable = false,
        )
        DeviceApiMock.enqueueBatchAccepted(server, deviceMsgId = "sms-a")
        val result = uploader.runOnce(nowEpochMs = 1_000L)
        assertTrue(result is UploadPassResult.MorePending)
        assertEquals(1, dao.rows.size)
        assertEquals("sms-b", dao.rows.single().deviceMsgId)
        assertEquals(2, server.requestCount)
    }

    @Test
    fun missingResultSchedulesRetryWithoutParking() = runBlocking {
        dao.rows += sample("sms-1")
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody("""{"results":[]}""")
                .addHeader("Content-Type", "application/json"),
        )
        val result = uploader.runOnce(nowEpochMs = 1_000L)
        assertTrue(result is UploadPassResult.Idle || result is UploadPassResult.MorePending)
        val row = dao.rows.single()
        assertTrue(!row.parked)
        assertEquals(1, row.attemptCount)
        assertEquals("missing_result", row.lastError)
        assertTrue(row.nextAttemptAtEpochMs > 1_000L)
    }

    @Test
    fun invalidSignatureStopsForRePairWithoutParking() = runBlocking {
        dao.rows += sample("sms-otp")
        DeviceApiMock.enqueueProblem(
            server,
            httpCode = 401,
            code = ProblemCodes.INVALID_SIGNATURE,
            title = "bad sig",
            detail = "mismatch",
            retryable = false,
        )
        val result = uploader.runOnce(nowEpochMs = 1_000L)
        assertTrue(result is UploadPassResult.StopForRePair)
        assertEquals(ProblemCodes.INVALID_SIGNATURE, (result as UploadPassResult.StopForRePair).code)
        assertTrue(!dao.rows.single().parked)
        assertEquals(0, dao.rows.single().attemptCount)
    }

    @Test
    fun explicitNonRetryable4xxParksBatch() = runBlocking {
        dao.rows += sample("sms-1")
        DeviceApiMock.enqueueProblem(
            server,
            httpCode = 400,
            code = ProblemCodes.INVALID_REQUEST,
            title = "bad",
            detail = "malformed",
            retryable = false,
        )
        val result = uploader.runOnce(nowEpochMs = 1_000L)
        assertTrue(result is UploadPassResult.MorePending)
        assertTrue(dao.rows.single().parked)
    }

    @Test
    fun unparkAllMakesRowsReadyAgain() = runBlocking {
        dao.rows += sample("sms-1").copy(parked = true, lastError = "http_404")
        dao.unparkAll(2_000L)
        val ready = dao.getReadyForUpload(2_000L, 10)
        assertEquals(1, ready.size)
        assertTrue(!ready.single().parked)
    }

    @Test
    fun duplicateInsertIgnored() = runBlocking {
        dao.rows += sample("sms-dup")
        assertEquals(-1L, dao.insert(sample("sms-dup", body = "other")))
        assertEquals(1, dao.rows.size)
        assertEquals("hello", dao.rows.single().body)
    }

    private fun sample(id: String, body: String = "hello") = QueuedMessageEntity(
        deviceMsgId = id,
        contentKey = id,
        sender = "+15551234567",
        body = body,
        receivedAt = "2026-11-18T09:45:12Z",
        direction = "inbound",
        simSlot = 0,
        createdAtEpochMs = 1L,
    )
}

private fun PairingCredentialsReader(
    block: suspend () -> PairingCredentials,
): PairingCredentialsReader = object : PairingCredentialsReader {
    override suspend fun current(): PairingCredentials = block()
}

private class FakeDao : QueuedMessageDao {
    val rows = mutableListOf<QueuedMessageEntity>()
    private val counters = mutableMapOf<String, Int>()

    override suspend fun getAll(): List<QueuedMessageEntity> = rows.toList()
    override fun observePendingCount(): Flow<Int> = flowOf(rows.count { !it.parked })
    override fun observeParkedCount(): Flow<Int> = flowOf(rows.count { it.parked })
    override fun observePendingRecent(limit: Int) = flowOf(rows.filter { !it.parked }.take(limit))
    override fun observeParkedRecent(limit: Int) = flowOf(rows.filter { it.parked }.take(limit))
    override suspend fun countPending() = rows.count { !it.parked }
    override suspend fun countAll() = rows.size
    override suspend fun countByContentKey(contentKey: String) = rows.count { it.contentKey == contentKey }
    override suspend fun getNextOrdinal(contentKey: String): Int? = counters[contentKey]
    override suspend fun upsertContentKeyCounter(counter: ContentKeyCounterEntity) {
        counters[counter.contentKey] = counter.nextOrdinal
    }
    override suspend fun getExpiredPending(cutoffEpochMs: Long) =
        rows.filter { !it.parked && it.createdAtEpochMs < cutoffEpochMs }
            .sortedBy { it.createdAtEpochMs }
    override suspend fun getOldestPending(limit: Int) =
        rows.filter { !it.parked }.sortedBy { it.createdAtEpochMs }.take(limit)
    override suspend fun getReadyForUpload(nowEpochMs: Long, limit: Int) =
        rows.filter { !it.parked && it.nextAttemptAtEpochMs <= nowEpochMs }
            .sortedBy { it.createdAtEpochMs }
            .take(limit)

    override suspend fun earliestPendingAttemptAtEpochMs(): Long? =
        rows.filter { !it.parked }.minOfOrNull { it.nextAttemptAtEpochMs }

    override suspend fun insert(message: QueuedMessageEntity): Long {
        if (rows.any { it.deviceMsgId == message.deviceMsgId }) return -1L
        rows += message
        return rows.size.toLong()
    }

    override suspend fun deleteById(deviceMsgId: String) {
        rows.removeAll { it.deviceMsgId == deviceMsgId }
    }

    override suspend fun deleteByIds(deviceMsgIds: List<String>) {
        rows.removeAll { it.deviceMsgId in deviceMsgIds }
    }

    override suspend fun deleteAll() {
        rows.clear()
    }

    override suspend fun park(deviceMsgId: String, error: String, nowEpochMs: Long) {
        val idx = rows.indexOfFirst { it.deviceMsgId == deviceMsgId }
        if (idx >= 0) {
            rows[idx] = rows[idx].copy(parked = true, lastError = error, nextAttemptAtEpochMs = nowEpochMs)
        }
    }

    override suspend fun markRetry(
        deviceMsgIds: List<String>,
        nextAttemptAtEpochMs: Long,
        error: String?,
    ) {
        rows.replaceAll { row ->
            if (row.deviceMsgId in deviceMsgIds) {
                row.copy(
                    attemptCount = row.attemptCount + 1,
                    nextAttemptAtEpochMs = nextAttemptAtEpochMs,
                    lastError = error,
                )
            } else {
                row
            }
        }
    }

    override suspend fun unparkAll(nowEpochMs: Long) {
        rows.replaceAll { row ->
            if (row.parked) {
                row.copy(parked = false, nextAttemptAtEpochMs = nowEpochMs, lastError = null)
            } else {
                row
            }
        }
    }
}
