package com.sthuck.smsgateway.data.remote

import com.sthuck.smsgateway.crypto.Base64Url
import com.sthuck.smsgateway.crypto.CanonicalString
import com.sthuck.smsgateway.crypto.ClockSkewStore
import com.sthuck.smsgateway.crypto.DeviceKeyAccess
import com.sthuck.smsgateway.crypto.DeviceSigner
import com.sthuck.smsgateway.crypto.PrivateKeyDeviceSigner
import com.sthuck.smsgateway.crypto.verifyEs256P1363
import com.sthuck.smsgateway.data.remote.dto.ProblemCodes
import com.sthuck.smsgateway.pairing.PairingCredentials
import com.sthuck.smsgateway.pairing.PairingSession
import com.sthuck.smsgateway.pairing.PairingStateAccess
import com.sthuck.smsgateway.testing.DeviceApiMock
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.ECGenParameterSpec
import javax.inject.Provider

class RequestSigningInterceptorTest {

    private var server: MockWebServer? = null
    private lateinit var credentials: FakeCredentials
    private lateinit var keys: FakeKeys
    private lateinit var clock: ClockSkewStore
    private lateinit var privateKey: PrivateKey
    private lateinit var publicKey: PublicKey
    private lateinit var client: OkHttpClient
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        namingStrategy = JsonNamingStrategy.SnakeCase
    }

    @Before
    fun setUp() {
        val kp = KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec("secp256r1"))
        }.generateKeyPair()
        privateKey = kp.private
        publicKey = kp.public

        val mock = MockWebServer()
        mock.start()
        server = mock
        credentials = FakeCredentials(
            PairingCredentials(DeviceApiMock.SAMPLE_DEVICE_ID, mock.url("/").toString()),
        )
        keys = FakeKeys(PrivateKeyDeviceSigner(privateKey))
        clock = ClockSkewStore()
        val interceptor = RequestSigningInterceptor(
            credentialStore = credentials,
            deviceKeyStore = keys,
            clockSkewStore = clock,
            pairingSession = PairingSession(),
            json = json,
            signerProvider = Provider { keys.requireSigner() },
        )
        client = OkHttpClient.Builder().addInterceptor(interceptor).build()
    }

    @After
    fun tearDown() {
        server?.shutdown()
    }

    @Test
    fun signsWithHostPortInCanonicalString() {
        val mock = server!!
        DeviceApiMock.enqueueBatchAccepted(mock)
        val body = """{"messages":[]}"""
        client.newCall(
            Request.Builder()
                .url(mock.url("/v1/messages:batch"))
                .post(body.toRequestBody("application/json".toMediaType()))
                .build(),
        ).execute().close()

        val recorded = mock.takeRequest()
        val host = RequestSigningInterceptor.hostHeaderValue(
            Request.Builder().url(recorded.requestUrl!!).build(),
        )
        val canonical = CanonicalString.build(
            method = "POST",
            path = "/v1/messages:batch",
            query = "",
            host = host,
            deviceId = DeviceApiMock.SAMPLE_DEVICE_ID,
            timestamp = recorded.getHeader(DeviceHeaders.TIMESTAMP)!!,
            contentSha256 = recorded.getHeader(DeviceHeaders.CONTENT_SHA256)!!,
            nonce = recorded.getHeader(DeviceHeaders.NONCE)!!,
        )
        assertTrue(
            verifyEs256P1363(
                publicKey,
                canonical.toByteArray(Charsets.UTF_8),
                Base64Url.decode(recorded.getHeader(DeviceHeaders.SIGNATURE)!!),
            ),
        )
        assertTrue(host.contains(":"))
    }

    @Test
    fun invalidTimestampRetriesWithFreshNonce() {
        val mock = server!!
        DeviceApiMock.enqueueProblem(
            mock,
            httpCode = 401,
            code = ProblemCodes.INVALID_TIMESTAMP,
            title = "skew",
            detail = "skew",
            retryable = true,
            serverTime = 1_794_995_160L,
            dateHeader = "Wed, 18 Nov 2026 09:46:00 GMT",
        )
        DeviceApiMock.enqueueDeviceMe(mock)

        client.newCall(
            Request.Builder().url(mock.url("/v1/devices/me")).get().build(),
        ).execute().close()

        assertEquals(2, mock.requestCount)
        val first = mock.takeRequest()
        val second = mock.takeRequest()
        assertNotEquals(first.getHeader(DeviceHeaders.NONCE), second.getHeader(DeviceHeaders.NONCE))
        assertNotEquals(
            first.getHeader(DeviceHeaders.TIMESTAMP),
            second.getHeader(DeviceHeaders.TIMESTAMP),
        )
        assertNotNull(second.getHeader(DeviceHeaders.SIGNATURE))
    }

    @Test
    fun deviceRevokedClearsPairing() {
        val mock = server!!
        DeviceApiMock.enqueueProblem(
            mock,
            httpCode = 403,
            code = ProblemCodes.DEVICE_REVOKED,
            title = "revoked",
            detail = "gone",
            retryable = false,
        )
        client.newCall(
            Request.Builder()
                .url(mock.url("/v1/messages:batch"))
                .post("{}".toRequestBody("application/json".toMediaType()))
                .build(),
        ).execute().close()

        assertNull(runBlocking { credentials.current() }.deviceId)
        assertTrue(keys.deleted)
    }

    @Test
    fun deviceUnknownClearsPairing() {
        val mock = server!!
        DeviceApiMock.enqueueProblem(
            mock,
            httpCode = 401,
            code = ProblemCodes.DEVICE_UNKNOWN,
            title = "unknown",
            detail = "gone",
            retryable = false,
        )
        client.newCall(
            Request.Builder()
                .url(mock.url("/v1/messages:batch"))
                .post("{}".toRequestBody("application/json".toMediaType()))
                .build(),
        ).execute().close()

        assertNull(runBlocking { credentials.current() }.deviceId)
        assertTrue(keys.deleted)
    }

    private class FakeCredentials(
        private var value: PairingCredentials,
    ) : PairingStateAccess {
        override suspend fun current() = value
        override suspend fun clearDeviceId() {
            value = value.copy(deviceId = null)
        }
        override suspend fun savePairing(deviceId: String, serverUrl: String) {
            value = PairingCredentials(deviceId, serverUrl)
        }
        override suspend fun clearAll() {
            value = PairingCredentials(null, value.serverUrl)
        }
    }

    private class FakeKeys(
        private val signer: DeviceSigner,
    ) : DeviceKeyAccess {
        var deleted = false
        override fun hasKey() = !deleted
        override fun hasPendingKey() = false
        override fun deleteKey() {
            deleted = true
        }
        override fun requireSigner() = signer
        override fun createPendingKeypair() = error("not used")
        override fun commitPendingKey() = error("not used")
        override fun discardPendingKey() = Unit
    }
}
