package com.sthuck.smsgateway.data.remote

import com.sthuck.smsgateway.data.remote.dto.BatchItemStatus
import com.sthuck.smsgateway.data.remote.dto.DEVICE_MESSAGE_BODY_MAX_CHARS
import com.sthuck.smsgateway.data.remote.dto.DeviceInfo
import com.sthuck.smsgateway.data.remote.dto.DeviceMessage
import com.sthuck.smsgateway.data.remote.dto.DeviceStatusValue
import com.sthuck.smsgateway.data.remote.dto.Direction
import com.sthuck.smsgateway.data.remote.dto.MessageBatchRequest
import com.sthuck.smsgateway.data.remote.dto.PairRequest
import com.sthuck.smsgateway.data.remote.dto.Problem
import com.sthuck.smsgateway.data.remote.dto.ProblemCodes
import com.sthuck.smsgateway.testing.DeviceApiMock
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

class DeviceApiTest {

    private lateinit var server: MockWebServer
    private lateinit var api: DeviceApi
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
        api = Retrofit.Builder()
            .baseUrl(server.url("/"))
            .client(OkHttpClient())
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(DeviceApi::class.java)
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun pairReturnsDeviceIdAndOmitsDeviceIdHeader() = runTest {
        DeviceApiMock.enqueuePairCreated(server)

        val response = api.pair(
            timestamp = "1794995160",
            nonce = "V1nQe4r0sK8mP2yL6dF9TQ",
            contentSha256 = "deadbeef",
            signature = "test-signature",
            body = PairRequest(
                pairingCode = "7K3M-9Q2P",
                publicKey = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyl6LQOh0Vol6Y7eUeYprtMPD_cB9oVwRFBAQ6BpcRbXZAXLl745jKd-uxX4bwUlHxH-jHsMc___m3WlOguxwRQ",
                deviceInfo = DeviceInfo(
                    appVersion = "0.1.0",
                    name = DeviceApiMock.SAMPLE_DEVICE_NAME,
                    platform = "android",
                    manufacturer = "Google",
                    model = "Pixel 8",
                    osVersion = "14",
                    sdkInt = 34,
                ),
            ),
        )

        assertEquals(DeviceApiMock.SAMPLE_DEVICE_ID, response.deviceId)
        assertEquals(DeviceApiMock.SAMPLE_DEVICE_NAME, response.name)
        assertEquals(DeviceStatusValue.Active, response.status)

        val recorded = server.takeRequest()
        assertEquals("POST", recorded.method)
        assertEquals("/v1/devices/pair", recorded.path)
        assertEquals("1794995160", recorded.getHeader(DeviceHeaders.TIMESTAMP))
        assertEquals("V1nQe4r0sK8mP2yL6dF9TQ", recorded.getHeader(DeviceHeaders.NONCE))
        assertEquals("deadbeef", recorded.getHeader(DeviceHeaders.CONTENT_SHA256))
        assertEquals("test-signature", recorded.getHeader(DeviceHeaders.SIGNATURE))
        assertEquals(null, recorded.getHeader(DeviceHeaders.DEVICE_ID))
        assertTrue(recorded.body.readUtf8().contains("\"pairing_code\""))
    }

    @Test
    fun batchIngestReturnsAcceptedAndSendsSigningHeaders() = runTest {
        DeviceApiMock.enqueueBatchAccepted(server, deviceMsgId = "sms-42")

        val response = api.ingestMessageBatch(
            deviceId = DeviceApiMock.SAMPLE_DEVICE_ID,
            timestamp = "1794995160",
            nonce = "V1nQe4r0sK8mP2yL6dF9TQ",
            contentSha256 = "8745a7b3b4b4b1fd81d08106e22e2d6261a203d0fc673b7cbf4aa7fbdeee4ea9",
            signature = "test-signature",
            body = MessageBatchRequest(
                messages = listOf(
                    DeviceMessage(
                        deviceMsgId = "sms-42",
                        sender = "+15551234567",
                        body = "Your code is 123456",
                        receivedAt = "2026-11-18T09:45:12Z",
                        simSlot = 0,
                        direction = Direction.Inbound,
                    ),
                ),
            ),
        )

        assertEquals(1, response.results.size)
        assertEquals("sms-42", response.results[0].deviceMsgId)
        assertEquals(BatchItemStatus.Accepted, response.results[0].status)
        assertEquals(DeviceApiMock.SAMPLE_SERVER_MESSAGE_ID, response.results[0].id)

        val recorded = server.takeRequest()
        assertEquals(DeviceApiMock.SAMPLE_DEVICE_ID, recorded.getHeader(DeviceHeaders.DEVICE_ID))
        assertEquals("1794995160", recorded.getHeader(DeviceHeaders.TIMESTAMP))
        assertEquals("V1nQe4r0sK8mP2yL6dF9TQ", recorded.getHeader(DeviceHeaders.NONCE))
        assertEquals(
            "8745a7b3b4b4b1fd81d08106e22e2d6261a203d0fc673b7cbf4aa7fbdeee4ea9",
            recorded.getHeader(DeviceHeaders.CONTENT_SHA256),
        )
        assertEquals("test-signature", recorded.getHeader(DeviceHeaders.SIGNATURE))
    }

    @Test
    fun getDeviceMeReturnsRevokedStatus() = runTest {
        DeviceApiMock.enqueueDeviceMe(server, status = "revoked")

        val response = api.getDeviceMe(
            deviceId = DeviceApiMock.SAMPLE_DEVICE_ID,
            timestamp = "1794995160",
            nonce = "V1nQe4r0sK8mP2yL6dF9TQ",
            contentSha256 = DeviceHeaders.EMPTY_BODY_SHA256,
            signature = "test-signature",
        )

        assertEquals(DeviceStatusValue.Revoked, response.status)
        assertEquals("2026-11-18T09:30:00Z", response.revokedAt)
        assertEquals(
            DeviceHeaders.EMPTY_BODY_SHA256,
            server.takeRequest().getHeader(DeviceHeaders.CONTENT_SHA256),
        )
    }

    @Test
    fun problemJsonExposesRetryableFlag() = runTest {
        DeviceApiMock.enqueueProblem(
            server,
            httpCode = 401,
            code = ProblemCodes.INVALID_TIMESTAMP,
            title = "Timestamp outside allowed window",
            detail = "X-Timestamp is more than 300 seconds from server time.",
            retryable = true,
            instance = "/v1/messages:batch",
        )

        try {
            api.getDeviceMe(
                deviceId = DeviceApiMock.SAMPLE_DEVICE_ID,
                timestamp = "1",
                nonce = "n",
                contentSha256 = DeviceHeaders.EMPTY_BODY_SHA256,
                signature = "s",
            )
            throw AssertionError("expected HttpException")
        } catch (e: HttpException) {
            assertEquals(401, e.code())
            val problem = json.decodeFromString<Problem>(e.response()!!.errorBody()!!.string())
            assertEquals(ProblemCodes.INVALID_TIMESTAMP, problem.code)
            assertTrue(problem.retryable)
        }
    }

    @Test
    fun invalidTimestampIncludesServerTimeAndDateHeader() = runTest {
        val serverTime = 1_794_995_160L
        val dateHeader = "Wed, 18 Nov 2026 09:46:00 GMT"
        DeviceApiMock.enqueueProblem(
            server,
            httpCode = 401,
            code = ProblemCodes.INVALID_TIMESTAMP,
            title = "Timestamp outside allowed window",
            detail = "X-Timestamp is more than 300 seconds from server time.",
            retryable = true,
            instance = "/v1/messages:batch",
            serverTime = serverTime,
            dateHeader = dateHeader,
        )

        try {
            api.getDeviceMe(
                deviceId = DeviceApiMock.SAMPLE_DEVICE_ID,
                timestamp = "1",
                nonce = "n",
                contentSha256 = DeviceHeaders.EMPTY_BODY_SHA256,
                signature = "s",
            )
            throw AssertionError("expected HttpException")
        } catch (e: HttpException) {
            assertEquals(401, e.code())
            assertEquals(dateHeader, e.response()!!.headers()["Date"])
            val problem = json.decodeFromString<Problem>(e.response()!!.errorBody()!!.string())
            assertEquals(ProblemCodes.INVALID_TIMESTAMP, problem.code)
            assertTrue(problem.retryable)
            assertEquals(serverTime, problem.serverTime)
        }
    }

    @Test
    fun deviceUnknownIsNotRetryableAndHasNoServerTime() = runTest {
        DeviceApiMock.enqueueProblem(
            server,
            httpCode = 401,
            code = ProblemCodes.DEVICE_UNKNOWN,
            title = "Unknown device",
            detail = "No device is registered for this X-Device-Id. Clear credentials and re-pair.",
            retryable = false,
            instance = "/v1/messages:batch",
        )

        try {
            api.ingestMessageBatch(
                deviceId = "00000000-0000-0000-0000-000000000000",
                timestamp = "1794995160",
                nonce = "V1nQe4r0sK8mP2yL6dF9TQ",
                contentSha256 = DeviceHeaders.EMPTY_BODY_SHA256,
                signature = "s",
                body = MessageBatchRequest(messages = emptyList()),
            )
            throw AssertionError("expected HttpException")
        } catch (e: HttpException) {
            assertEquals(401, e.code())
            val problem = json.decodeFromString<Problem>(e.response()!!.errorBody()!!.string())
            assertEquals(ProblemCodes.DEVICE_UNKNOWN, problem.code)
            assertFalse(problem.retryable)
            assertNull(problem.serverTime)
        }
    }

    @Test
    fun problemJsonRetryableFalse() {
        val body = DeviceApiMock.problem(
            httpCode = 403,
            code = ProblemCodes.DEVICE_REVOKED,
            title = "Device revoked",
            detail = "This device credential has been revoked. Pair a new device.",
            retryable = false,
            instance = "/v1/messages:batch",
        ).getBody()!!.readUtf8()
        val problem = json.decodeFromString<Problem>(body)
        assertEquals(ProblemCodes.DEVICE_REVOKED, problem.code)
        assertFalse(problem.retryable)
        assertEquals(403, problem.status)
        assertNull(problem.serverTime)
    }

    @Test
    fun deviceMessageBodyCapMatchesDraft2() {
        assertEquals(32_768, DEVICE_MESSAGE_BODY_MAX_CHARS)
        val atCap = "x".repeat(DEVICE_MESSAGE_BODY_MAX_CHARS)
        val message = DeviceMessage(
            deviceMsgId = "sms-cap",
            sender = "+15551234567",
            body = atCap,
            receivedAt = "2026-11-18T09:45:12Z",
            direction = Direction.Inbound,
        )
        assertEquals(DEVICE_MESSAGE_BODY_MAX_CHARS, message.body.length)
        assertEquals(ProblemCodes.BODY_TOO_LARGE, "body_too_large")
    }
}

