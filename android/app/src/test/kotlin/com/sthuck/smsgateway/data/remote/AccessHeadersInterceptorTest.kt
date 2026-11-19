package com.sthuck.smsgateway.data.remote

import com.sthuck.smsgateway.crypto.Base64Url
import com.sthuck.smsgateway.crypto.CanonicalString
import com.sthuck.smsgateway.crypto.ClockSkewStore
import com.sthuck.smsgateway.crypto.DeviceKeyAccess
import com.sthuck.smsgateway.crypto.DeviceSigner
import com.sthuck.smsgateway.crypto.PrivateKeyDeviceSigner
import com.sthuck.smsgateway.crypto.verifyEs256P1363
import com.sthuck.smsgateway.data.remote.dto.DeviceInfo
import com.sthuck.smsgateway.data.remote.dto.PairRequest
import com.sthuck.smsgateway.di.NetworkModule
import com.sthuck.smsgateway.pairing.DeviceRevocationHandler
import com.sthuck.smsgateway.pairing.PairingCredentials
import com.sthuck.smsgateway.pairing.PairingSession
import com.sthuck.smsgateway.pairing.PairingStateAccess
import com.sthuck.smsgateway.testing.DeviceApiMock
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.net.InetAddress
import java.security.KeyPairGenerator
import java.security.PublicKey
import java.security.spec.ECGenParameterSpec
import javax.inject.Provider

class AccessHeadersInterceptorTest {

    private lateinit var primaryServer: MockWebServer
    private lateinit var otherServer: MockWebServer
    private lateinit var credentials: FakeStateAccess
    private lateinit var publicKey: PublicKey
    private lateinit var client: OkHttpClient
    private lateinit var api: DeviceApi
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        namingStrategy = JsonNamingStrategy.SnakeCase
    }

    @Before
    fun setUp() {
        val loopback = InetAddress.getByName("127.0.0.1")
        primaryServer = MockWebServer().apply { start(loopback, 0) }
        otherServer = MockWebServer().apply { start(loopback, 0) }

        val kp = KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec("secp256r1"))
        }.generateKeyPair()
        publicKey = kp.public
        val keys = FakeKeys(PrivateKeyDeviceSigner(kp.private))

        val primaryUrl = "http://127.0.0.1:${primaryServer.port}"
        credentials = FakeStateAccess(
            PairingCredentials(
                deviceId = DeviceApiMock.SAMPLE_DEVICE_ID,
                serverUrl = primaryUrl,
                accessHeaders = mapOf(
                    "CF-Access-Client-Id" to "stored-id",
                    "CF-Access-Client-Secret" to "stored-secret",
                ),
            ),
        )
        val clock = ClockSkewStore()
        val signingInterceptor = RequestSigningInterceptor(
            credentialStore = credentials,
            deviceKeyStore = keys,
            clockSkewStore = clock,
            revocationHandler = DeviceRevocationHandler(
                credentialStore = credentials,
                deviceKeyStore = keys,
                clockSkewStore = clock,
                pairingSession = PairingSession(),
            ),
            json = json,
            signerProvider = Provider { keys.requireSigner() },
        )
        client = NetworkModule.okHttpClient(
            backendUrlInterceptor = BackendUrlInterceptor(credentials),
            accessHeadersInterceptor = AccessHeadersInterceptor(credentials),
            requestSigningInterceptor = signingInterceptor,
        )
        api = Retrofit.Builder()
            .baseUrl("http://localhost/")
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(DeviceApi::class.java)
    }

    @After
    fun tearDown() {
        primaryServer.shutdown()
        otherServer.shutdown()
    }

    @Test
    fun pairUsesOnlyTagHeadersAndNeverLeaksStoredHeadersToCandidateHost() = runTest {
        otherServer.enqueue(DeviceApiMock.pairCreated())
        val candidateUrl = "http://127.0.0.1:${otherServer.port}"
        val candidateOrigin = AccessHeadersInterceptor.originKey(candidateUrl)!!

        api.pair(
            url = "$candidateUrl/v1/devices/pair",
            body = PairRequest(
                pairingCode = "7K3M-9Q2P",
                publicKey = "spki",
                deviceInfo = DeviceInfo(appVersion = "0.1.0"),
            ),
            pairAccessHeaders = PairAccessHeadersTag(
                serverOrigin = candidateOrigin,
                headers = mapOf(
                    "CF-Access-Client-Id" to "candidate-id",
                    "CF-Access-Client-Secret" to "candidate-secret",
                ),
            ),
        )

        val recorded = otherServer.takeRequest()
        assertEquals("candidate-id", recorded.getHeader("CF-Access-Client-Id"))
        assertEquals("candidate-secret", recorded.getHeader("CF-Access-Client-Secret"))

        // Pair without tag while already paired must NOT send stored headers either.
        otherServer.enqueue(DeviceApiMock.pairCreated())
        api.pair(
            url = "$candidateUrl/v1/devices/pair",
            body = PairRequest(
                pairingCode = "7K3M-9Q2P",
                publicKey = "spki",
                deviceInfo = DeviceInfo(appVersion = "0.1.0"),
            ),
            pairAccessHeaders = null,
        )
        val untagged = otherServer.takeRequest()
        assertNull(untagged.getHeader("CF-Access-Client-Id"))
        assertNull(untagged.getHeader("CF-Access-Client-Secret"))
    }

    @Test
    fun pairRejectsTagWhenOriginDoesNotMatchRequestUrl() = runTest {
        otherServer.enqueue(DeviceApiMock.pairCreated())
        val candidateUrl = "http://127.0.0.1:${otherServer.port}"
        val mismatchedOrigin = AccessHeadersInterceptor.originKey("http://127.0.0.1:${primaryServer.port}")!!

        api.pair(
            url = "$candidateUrl/v1/devices/pair",
            body = PairRequest(
                pairingCode = "7K3M-9Q2P",
                publicKey = "spki",
                deviceInfo = DeviceInfo(appVersion = "0.1.0"),
            ),
            pairAccessHeaders = PairAccessHeadersTag(
                serverOrigin = mismatchedOrigin,
                headers = mapOf("CF-Access-Client-Id" to "wrong-host-id"),
            ),
        )

        val recorded = otherServer.takeRequest()
        assertNull(recorded.getHeader("CF-Access-Client-Id"))
    }

    @Test
    fun pairedRequestsAttachStoredHeadersOnlyToMatchingOriginAndPreserveEs256Signature() = runTest {
        primaryServer.enqueue(DeviceApiMock.deviceMe())
        api.getDeviceMe()

        val recorded = primaryServer.takeRequest()
        assertEquals("stored-id", recorded.getHeader("CF-Access-Client-Id"))
        assertEquals("stored-secret", recorded.getHeader("CF-Access-Client-Secret"))

        // Verify ES256 signature remains valid (custom headers are outside canonical string).
        val host = RequestSigningInterceptor.hostHeaderValue(
            Request.Builder().url(recorded.requestUrl!!).build(),
        )
        val canonical = CanonicalString.build(
            method = "GET",
            path = "/v1/devices/me",
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

        // Direct request to a non-matching origin must NOT receive stored headers.
        otherServer.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        client.newCall(
            Request.Builder().url("http://127.0.0.1:${otherServer.port}/v1/devices/me").get().build(),
        ).execute().close()

        val leakedCheck = otherServer.takeRequest()
        assertNull(leakedCheck.getHeader("CF-Access-Client-Id"))
        assertNull(leakedCheck.getHeader("CF-Access-Client-Secret"))
    }

    @Test
    fun redirectIsNotFollowedAndHeadersAreNotForwardedToRedirectTarget() {
        val redirectTarget = "http://127.0.0.1:${otherServer.port}/login"
        primaryServer.enqueue(
            MockResponse()
                .setResponseCode(302)
                .addHeader("Location", redirectTarget),
        )

        val response = client.newCall(
            Request.Builder().url("http://localhost/v1/devices/me").get().build(),
        ).execute()
        response.use {
            assertEquals(302, it.code)
        }
        assertEquals(1, primaryServer.requestCount)
        assertEquals(0, otherServer.requestCount)
    }

    private class FakeStateAccess(
        private var value: PairingCredentials,
    ) : PairingStateAccess {
        override suspend fun current() = value
        override suspend fun clearDeviceId() {
            value = value.copy(deviceId = null, accessHeaders = emptyMap(), tunnelAuthError = null)
        }
        override suspend fun savePairing(
            deviceId: String,
            serverUrl: String,
            activeKeyAlias: String,
            deviceName: String,
            accessHeaders: Map<String, String>,
        ) {
            value = PairingCredentials(deviceId, serverUrl, activeKeyAlias, deviceName, accessHeaders = accessHeaders)
        }
        override suspend fun updateDeviceName(deviceName: String) {
            value = value.copy(deviceName = deviceName)
        }
        override suspend fun recordSuccessfulSync(atEpochMs: Long) {
            value = value.copy(lastSuccessfulSyncAtEpochMs = atEpochMs, tunnelAuthError = null)
        }
        override suspend fun recordTunnelAuthError(message: String?) {
            value = value.copy(tunnelAuthError = message)
        }
        override suspend fun clearAll() {
            value = PairingCredentials(null, value.serverUrl)
        }
    }

    private class FakeKeys(
        private val signer: DeviceSigner,
    ) : DeviceKeyAccess {
        override fun hasKey() = true
        override fun hasPendingKey() = false
        override fun deleteKey() = Unit
        override fun requireSigner() = signer
        override fun requirePendingSigner() = signer
        override fun createPendingKeypair() = "pending"
        override fun commitPendingKey() = "alias_a"
        override fun currentActiveAlias() = "alias_a"
        override fun restorePreferredActiveAlias(alias: String?) = Unit
        override fun deleteKeyAlias(alias: String) = Unit
        override fun discardPendingKey() = Unit
    }
}
