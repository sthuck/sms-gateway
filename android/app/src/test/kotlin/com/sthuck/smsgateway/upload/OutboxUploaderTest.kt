package com.sthuck.smsgateway.upload

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
        uploader = OutboxUploader(dao, api, credentials, PairingSession(), json)
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

    override suspend fun getAll(): List<QueuedMessageEntity> = rows.toList()
    override fun observePendingCount(): Flow<Int> = flowOf(rows.count { !it.parked })
    override fun observeParkedCount(): Flow<Int> = flowOf(rows.count { it.parked })
    override fun observePendingRecent(limit: Int) = flowOf(rows.filter { !it.parked }.take(limit))
    override fun observeParkedRecent(limit: Int) = flowOf(rows.filter { it.parked }.take(limit))
    override suspend fun countByContentKey(contentKey: String) = rows.count { it.contentKey == contentKey }
    override suspend fun getReadyForUpload(nowEpochMs: Long, limit: Int) =
        rows.filter { !it.parked && it.nextAttemptAtEpochMs <= nowEpochMs }
            .sortedBy { it.createdAtEpochMs }
            .take(limit)

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
}
