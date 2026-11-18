package com.sthuck.smsgateway.pairing

import com.sthuck.smsgateway.crypto.DeviceKeyAccess
import com.sthuck.smsgateway.crypto.DeviceSigner
import com.sthuck.smsgateway.crypto.PrivateKeyDeviceSigner
import com.sthuck.smsgateway.data.local.QueuedMessageDao
import com.sthuck.smsgateway.data.local.QueuedMessageEntity
import com.sthuck.smsgateway.data.remote.BackendUrlOverride
import com.sthuck.smsgateway.data.remote.DeviceApi
import com.sthuck.smsgateway.testing.DeviceApiMock
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.runBlocking
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
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class PairingRepositoryTest {

    private lateinit var server: MockWebServer
    private lateinit var credentials: FakeCredentials
    private lateinit var keys: FakeKeys
    private lateinit var dao: FakeQueuedDao
    private lateinit var repo: PairingRepository
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        namingStrategy = JsonNamingStrategy.SnakeCase
    }

    @Before
    fun setUp() {
        val privateKey = KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec("secp256r1"))
        }.generateKeyPair().private

        server = MockWebServer()
        server.start()
        credentials = FakeCredentials(
            PairingCredentials(deviceId = "existing-device", serverUrl = "https://sms.sthuck.info"),
        )
        keys = FakeKeys(PrivateKeyDeviceSigner(privateKey), initiallyHasKey = true)
        dao = FakeQueuedDao()
        val api = Retrofit.Builder()
            .baseUrl(server.url("/"))
            .client(OkHttpClient())
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(DeviceApi::class.java)
        repo = PairingRepository(
            deviceApi = api,
            deviceKeyStore = keys,
            credentialStore = credentials,
            queuedMessageDao = dao,
            backendUrlOverride = BackendUrlOverride(),
            json = json,
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun failedPairLeavesExistingPairingUntouched() = runBlocking {
        assumeTrue(
            "dev flavour required for http://10.0.2.2 mock URL",
            com.sthuck.smsgateway.BuildConfig.FLAVOR == "dev",
        )
        DeviceApiMock.enqueueProblem(
            server,
            httpCode = 400,
            code = "invalid_pairing_code",
            title = "bad",
            detail = "used",
            retryable = false,
            instance = "/v1/devices/pair",
        )
        val before = credentials.current()
        val result = repo.pair("7K3M-9Q2P", "http://10.0.2.2:4010")
        assertTrue(result is PairingResult.Failure)
        assertEquals(before.deviceId, credentials.current().deviceId)
        assertEquals(before.serverUrl, credentials.current().serverUrl)
        assertTrue(keys.hasKey())
        assertFalse(keys.hasPendingKey())
        assertEquals(1, keys.createCount.get())
        assertEquals(1, keys.discardCount.get())
        assertEquals(0, keys.commitCount.get())
        assertEquals(1, server.requestCount)
    }

    @Test
    fun successfulPairCommitsOnlyAfterResponse() = runBlocking {
        assumeTrue(com.sthuck.smsgateway.BuildConfig.FLAVOR == "dev")
        DeviceApiMock.enqueuePairCreated(server)
        val result = repo.pair("7K3M-9Q2P", "http://10.0.2.2:4010")
        assertTrue("got $result", result is PairingResult.Success)
        assertEquals(DeviceApiMock.SAMPLE_DEVICE_ID, credentials.current().deviceId)
        assertEquals("http://10.0.2.2:4010", credentials.current().serverUrl)
        assertEquals(1, keys.commitCount.get())
        assertEquals(0, keys.discardCount.get())
        assertTrue(keys.hasKey())
        assertFalse(keys.hasPendingKey())
    }

    @Test
    fun unpairCanKeepQueue() = runBlocking {
        dao.rows.set(3)
        repo.unpair(clearQueue = false)
        assertNull(credentials.current().deviceId)
        assertFalse(keys.hasKey())
        assertEquals(3, dao.rows.get())
        assertEquals(0, dao.deleteAllCount.get())
    }

    @Test
    fun unpairClearsQueueWhenRequested() = runBlocking {
        dao.rows.set(2)
        repo.unpair(clearQueue = true)
        assertEquals(0, dao.rows.get())
        assertEquals(1, dao.deleteAllCount.get())
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
            value = PairingCredentials(null, "https://sms.sthuck.info")
        }
    }

    private class FakeKeys(
        private val signer: DeviceSigner,
        initiallyHasKey: Boolean,
    ) : DeviceKeyAccess {
        private val active = AtomicBoolean(initiallyHasKey)
        private val pending = AtomicBoolean(false)
        val createCount = AtomicInteger(0)
        val commitCount = AtomicInteger(0)
        val discardCount = AtomicInteger(0)

        override fun hasKey() = active.get()
        override fun hasPendingKey() = pending.get()
        override fun deleteKey() {
            active.set(false)
            pending.set(false)
        }
        override fun requireSigner() = signer
        override fun createPendingKeypair(): String {
            createCount.incrementAndGet()
            pending.set(true)
            return "pending-spki"
        }
        override fun commitPendingKey() {
            commitCount.incrementAndGet()
            pending.set(false)
            active.set(true)
        }
        override fun discardPendingKey() {
            discardCount.incrementAndGet()
            pending.set(false)
        }
    }

    private class FakeQueuedDao : QueuedMessageDao {
        val rows = AtomicInteger(0)
        val deleteAllCount = AtomicInteger(0)

        override suspend fun getAll(): List<QueuedMessageEntity> = emptyList()
        override fun observePendingCount(): Flow<Int> = flowOf(rows.get())
        override fun observeParkedCount(): Flow<Int> = flowOf(0)
        override fun observePendingRecent(limit: Int): Flow<List<QueuedMessageEntity>> =
            flowOf(emptyList())
        override fun observeParkedRecent(limit: Int): Flow<List<QueuedMessageEntity>> =
            flowOf(emptyList())
        override suspend fun countByContentKey(contentKey: String): Int = 0
        override suspend fun getReadyForUpload(
            nowEpochMs: Long,
            limit: Int,
        ): List<QueuedMessageEntity> = emptyList()
        override suspend fun insert(message: QueuedMessageEntity): Long {
            rows.incrementAndGet()
            return 1L
        }
        override suspend fun deleteById(deviceMsgId: String) = Unit
        override suspend fun deleteByIds(deviceMsgIds: List<String>) = Unit
        override suspend fun deleteAll() {
            deleteAllCount.incrementAndGet()
            rows.set(0)
        }
        override suspend fun park(deviceMsgId: String, error: String, nowEpochMs: Long) = Unit
        override suspend fun markRetry(
            deviceMsgIds: List<String>,
            nextAttemptAtEpochMs: Long,
            error: String?,
        ) = Unit
    }
}
