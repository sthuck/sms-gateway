package com.sthuck.smsgateway.pairing

import com.sthuck.smsgateway.crypto.DeviceKeyAccess
import com.sthuck.smsgateway.crypto.DeviceSigner
import com.sthuck.smsgateway.crypto.PrivateKeyDeviceSigner
import com.sthuck.smsgateway.data.local.QueuedMessageDao
import com.sthuck.smsgateway.data.local.QueuedMessageEntity
import com.sthuck.smsgateway.data.remote.DeviceApi
import com.sthuck.smsgateway.data.remote.dto.PairRequest
import com.sthuck.smsgateway.data.remote.dto.PairResponse
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
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class PairingRepositoryTest {

    private lateinit var server: MockWebServer
    private lateinit var credentials: FakeCredentials
    private lateinit var keys: FakeKeys
    private lateinit var dao: FakeQueuedDao
    private lateinit var repo: PairingRepository
    private lateinit var recordingApi: RecordingDeviceApi
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        namingStrategy = JsonNamingStrategy.SnakeCase
    }
    private val events = mutableListOf<String>()

    @Before
    fun setUp() {
        events.clear()
        val privateKey = KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec("secp256r1"))
        }.generateKeyPair().private

        server = MockWebServer()
        server.start()
        credentials = FakeCredentials(
            PairingCredentials(deviceId = "existing-device", serverUrl = "https://sms.sthuck.info"),
            events,
        )
        keys = FakeKeys(PrivateKeyDeviceSigner(privateKey), initiallyHasKey = true, events)
        dao = FakeQueuedDao()
        recordingApi = RecordingDeviceApi(
            delegate = Retrofit.Builder()
                .baseUrl(server.url("/"))
                .client(OkHttpClient())
                .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
                .build()
                .create(DeviceApi::class.java),
        )
        repo = PairingRepository(
            deviceApi = recordingApi,
            deviceKeyStore = keys,
            credentialStore = credentials,
            queuedMessageDao = dao,
            json = json,
        )
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun failedPairLeavesExistingPairingUntouched() = runBlocking {
        assumeTrue(com.sthuck.smsgateway.BuildConfig.FLAVOR == "dev")
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
        val candidate = server.url("/").toString().trimEnd('/')
        val result = repo.pair("7K3M-9Q2P", candidate)
        assertTrue(result is PairingResult.Failure)
        assertEquals(before.deviceId, credentials.current().deviceId)
        assertEquals(before.serverUrl, credentials.current().serverUrl)
        assertTrue(keys.hasKey())
        assertFalse(keys.hasPendingKey())
        assertEquals(1, keys.createCount.get())
        assertEquals(1, keys.discardCount.get())
        assertEquals(0, keys.commitCount.get())
        assertEquals(1, server.requestCount)
        assertFalse(events.contains("save"))
        assertFalse(events.contains("commit"))
    }

    @Test
    fun successfulPairCommitsKeyBeforeSavingCredentials() = runBlocking {
        assumeTrue(com.sthuck.smsgateway.BuildConfig.FLAVOR == "dev")
        DeviceApiMock.enqueuePairCreated(server)
        val candidate = server.url("/").toString().trimEnd('/')
        val result = repo.pair("7K3M-9Q2P", candidate)
        assertTrue("got $result", result is PairingResult.Success)
        assertEquals(DeviceApiMock.SAMPLE_DEVICE_ID, credentials.current().deviceId)
        assertEquals(candidate, credentials.current().serverUrl)
        assertEquals(1, keys.commitCount.get())
        assertEquals(0, keys.discardCount.get())
        assertTrue(keys.hasKey())
        assertFalse(keys.hasPendingKey())
        val commitIdx = events.indexOf("commit")
        val saveIdx = events.indexOf("save")
        assertTrue("commit before save: $events", commitIdx >= 0 && saveIdx > commitIdx)
    }

    @Test
    fun pairPassesAbsoluteCandidateUrlOnlyOnThatCall() = runBlocking {
        assumeTrue(com.sthuck.smsgateway.BuildConfig.FLAVOR == "dev")
        DeviceApiMock.enqueuePairCreated(server)
        val candidate = server.url("/").toString().trimEnd('/')
        repo.pair("7K3M-9Q2P", candidate)
        assertEquals(
            PairingRepository.pairEndpoint(candidate),
            recordingApi.lastPairUrl.get(),
        )
        // Stored credentials were https://sms.sthuck.info until save; the pair
        // call did not go through a process-global override — only @Url.
        assertEquals(1, recordingApi.pairCallCount.get())
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

    private class RecordingDeviceApi(
        private val delegate: DeviceApi,
    ) : DeviceApi by delegate {
        val lastPairUrl = AtomicReference<String?>(null)
        val pairCallCount = AtomicInteger(0)

        override suspend fun pair(url: String, body: PairRequest): PairResponse {
            pairCallCount.incrementAndGet()
            lastPairUrl.set(url)
            return delegate.pair(url, body)
        }
    }

    private class FakeCredentials(
        private var value: PairingCredentials,
        private val events: MutableList<String>,
    ) : PairingStateAccess {
        override suspend fun current() = value
        override suspend fun clearDeviceId() {
            value = value.copy(deviceId = null)
        }
        override suspend fun savePairing(deviceId: String, serverUrl: String) {
            events += "save"
            value = PairingCredentials(deviceId, serverUrl)
        }
        override suspend fun clearAll() {
            value = PairingCredentials(null, "https://sms.sthuck.info")
        }
    }

    private class FakeKeys(
        private val signer: DeviceSigner,
        initiallyHasKey: Boolean,
        private val events: MutableList<String>,
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
        override fun requirePendingSigner() = signer
        override fun createPendingKeypair(): String {
            createCount.incrementAndGet()
            pending.set(true)
            return "pending-spki"
        }
        override fun commitPendingKey() {
            events += "commit"
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
