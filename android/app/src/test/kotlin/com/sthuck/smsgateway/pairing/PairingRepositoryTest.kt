package com.sthuck.smsgateway.pairing

import com.sthuck.smsgateway.crypto.DeviceKeyAccess
import com.sthuck.smsgateway.crypto.DeviceSigner
import com.sthuck.smsgateway.crypto.PrivateKeyDeviceSigner
import com.sthuck.smsgateway.data.local.ContentKeyCounterEntity
import com.sthuck.smsgateway.data.local.QueuedMessageDao
import com.sthuck.smsgateway.data.local.QueuedMessageEntity
import com.sthuck.smsgateway.data.remote.AccessHeadersInterceptor
import com.sthuck.smsgateway.data.remote.DeviceApi
import com.sthuck.smsgateway.data.remote.PairAccessHeadersTag
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
                .client(
                    OkHttpClient.Builder()
                        .followRedirects(false)
                        .followSslRedirects(false)
                        .build(),
                )
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
        assertEquals("alias_b", credentials.current().activeKeyAlias)
        assertEquals(1, keys.commitCount.get())
        assertEquals(0, keys.discardCount.get())
        assertTrue(keys.hasKey())
        assertFalse(keys.hasPendingKey())
        val commitIdx = events.indexOf("commit")
        val saveIdx = events.indexOf("save")
        val deleteIdx = events.indexOf("delete:alias_a")
        assertTrue("commit before save: $events", commitIdx >= 0 && saveIdx > commitIdx)
        assertTrue("delete previous after save: $events", deleteIdx > saveIdx)
        assertEquals(listOf("alias_a"), keys.deletedAliases)
        assertEquals(1, dao.unparkCount.get())
        assertTrue(dao.parkedIds.isEmpty())
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

    @Test
    fun failedRePairPreservesExistingPairingAndStoredHeaders() = runBlocking {
        assumeTrue(com.sthuck.smsgateway.BuildConfig.FLAVOR == "dev")
        val oldHeaders = mapOf("CF-Access-Client-Id" to "old-id", "CF-Access-Client-Secret" to "old-sec")
        credentials.savePairing(
            deviceId = "existing-device",
            serverUrl = "https://sms.sthuck.info",
            activeKeyAlias = "alias_a",
            deviceName = "Existing",
            accessHeaders = oldHeaders,
        )
        events.clear()

        server.enqueue(
            okhttp3.mockwebserver.MockResponse()
                .setResponseCode(403)
                .addHeader("Content-Type", "text/html")
                .setBody("<html>Access denied</html>"),
        )
        val candidate = server.url("/").toString().trimEnd('/')
        val newHeaders = mapOf("CF-Access-Client-Id" to "new-id", "CF-Access-Client-Secret" to "new-sec")
        val result = repo.pair("7K3M-9Q2P", candidate, newHeaders)
        assertTrue(result is PairingResult.Failure)
        val msg = (result as PairingResult.Failure).message
        assertTrue("expected tunnel auth message, got: $msg", msg.contains("HTTP 403"))
        assertEquals("existing-device", credentials.current().deviceId)
        assertEquals("https://sms.sthuck.info", credentials.current().serverUrl)
        assertEquals(oldHeaders, credentials.current().accessHeaders)
        assertFalse(events.contains("save"))
    }

    @Test
    fun proxy302OnPairReturnsClearTunnelError() = runBlocking {
        assumeTrue(com.sthuck.smsgateway.BuildConfig.FLAVOR == "dev")
        server.enqueue(
            okhttp3.mockwebserver.MockResponse()
                .setResponseCode(302)
                .addHeader("Location", "https://example.cloudflareaccess.com/cdn-cgi/access/login"),
        )
        val candidate = server.url("/").toString().trimEnd('/')
        val result = repo.pair("7K3M-9Q2P", candidate)
        assertTrue(result is PairingResult.Failure)
        assertTrue((result as PairingResult.Failure).message.contains("HTTP 302"))
    }

    @Test
    fun successfulPairWithHeadersPassesOriginScopedTagAndCommitsHeaders() = runBlocking {
        assumeTrue(com.sthuck.smsgateway.BuildConfig.FLAVOR == "dev")
        DeviceApiMock.enqueuePairCreated(server)
        val candidate = server.url("/").toString().trimEnd('/')
        val headers = mapOf("CF-Access-Client-Id" to "id-1", "CF-Access-Client-Secret" to "sec-2")
        val result = repo.pair("7K3M-9Q2P", candidate, headers)
        assertTrue(result is PairingResult.Success)
        assertEquals(headers, credentials.current().accessHeaders)
        assertEquals(
            PairAccessHeadersTag(
                serverOrigin = AccessHeadersInterceptor.originKey(candidate)!!,
                headers = headers,
            ),
            recordingApi.lastPairTag.get(),
        )
    }

    private class RecordingDeviceApi(
        private val delegate: DeviceApi,
    ) : DeviceApi by delegate {
        val lastPairUrl = AtomicReference<String?>(null)
        val lastPairTag = AtomicReference<PairAccessHeadersTag?>(null)
        val pairCallCount = AtomicInteger(0)

        override suspend fun pair(
            url: String,
            body: PairRequest,
            pairAccessHeaders: PairAccessHeadersTag?,
        ): PairResponse {
            pairCallCount.incrementAndGet()
            lastPairUrl.set(url)
            lastPairTag.set(pairAccessHeaders)
            return delegate.pair(url, body, pairAccessHeaders)
        }
    }

    private class FakeCredentials(
        private var value: PairingCredentials,
        private val events: MutableList<String>,
    ) : PairingStateAccess {
        override suspend fun current() = value
        override suspend fun clearDeviceId() {
            value = value.copy(
                deviceId = null,
                deviceName = null,
                lastSuccessfulSyncAtEpochMs = null,
                accessHeaders = emptyMap(),
                tunnelAuthError = null,
            )
        }
        override suspend fun savePairing(
            deviceId: String,
            serverUrl: String,
            activeKeyAlias: String,
            deviceName: String,
            accessHeaders: Map<String, String>,
        ) {
            events += "save"
            value = PairingCredentials(
                deviceId = deviceId,
                serverUrl = serverUrl,
                activeKeyAlias = activeKeyAlias,
                deviceName = deviceName,
                accessHeaders = accessHeaders,
                tunnelAuthError = null,
            )
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
        private var activeAlias: String? = if (initiallyHasKey) "alias_a" else null
        private var pendingAlias: String? = null
        val createCount = AtomicInteger(0)
        val commitCount = AtomicInteger(0)
        val discardCount = AtomicInteger(0)
        val deletedAliases = mutableListOf<String>()

        override fun hasKey() = active.get()
        override fun hasPendingKey() = pending.get()
        override fun deleteKey() {
            active.set(false)
            pending.set(false)
            activeAlias = null
            pendingAlias = null
        }
        override fun requireSigner() = signer
        override fun requirePendingSigner() = signer
        override fun createPendingKeypair(): String {
            createCount.incrementAndGet()
            pending.set(true)
            pendingAlias = "alias_b"
            return "pending-spki"
        }
        override fun commitPendingKey(): String {
            events += "commit"
            commitCount.incrementAndGet()
            val next = pendingAlias ?: error("no pending")
            pending.set(false)
            pendingAlias = null
            active.set(true)
            activeAlias = next
            return next
        }
        override fun currentActiveAlias(): String? = activeAlias
        override fun restorePreferredActiveAlias(alias: String?) {
            if (alias != null) activeAlias = alias
        }
        override fun deleteKeyAlias(alias: String) {
            events += "delete:$alias"
            deletedAliases += alias
        }
        override fun discardPendingKey() {
            discardCount.incrementAndGet()
            pending.set(false)
            pendingAlias = null
        }
    }

    private class FakeQueuedDao : QueuedMessageDao {
        val rows = AtomicInteger(0)
        val deleteAllCount = AtomicInteger(0)
        val unparkCount = AtomicInteger(0)
        val parkedIds = mutableSetOf<String>()

        override suspend fun getAll(): List<QueuedMessageEntity> = emptyList()
        override suspend fun countPending(): Int = rows.get() - parkedIds.size
        override suspend fun countAll(): Int = rows.get()
        override fun observePendingCount(): Flow<Int> = flowOf(rows.get())
        override fun observeParkedCount(): Flow<Int> = flowOf(parkedIds.size)
        override fun observePendingRecent(limit: Int): Flow<List<QueuedMessageEntity>> =
            flowOf(emptyList())
        override fun observeParkedRecent(limit: Int): Flow<List<QueuedMessageEntity>> =
            flowOf(emptyList())
        override suspend fun countByContentKey(contentKey: String): Int = 0
        override suspend fun getNextOrdinal(contentKey: String): Int? = null
        override suspend fun upsertContentKeyCounter(counter: ContentKeyCounterEntity) = Unit
        override suspend fun getReadyForUpload(
            nowEpochMs: Long,
            limit: Int,
        ): List<QueuedMessageEntity> = emptyList()
        override suspend fun earliestPendingAttemptAtEpochMs(): Long? = null
        override suspend fun getExpiredPending(cutoffEpochMs: Long): List<QueuedMessageEntity> =
            emptyList()
        override suspend fun getOldestPending(limit: Int): List<QueuedMessageEntity> = emptyList()
        override suspend fun insert(message: QueuedMessageEntity): Long {
            rows.incrementAndGet()
            return 1L
        }
        override suspend fun deleteById(deviceMsgId: String) = Unit
        override suspend fun deleteByIds(deviceMsgIds: List<String>) = Unit
        override suspend fun deleteAll() {
            deleteAllCount.incrementAndGet()
            rows.set(0)
            parkedIds.clear()
        }
        override suspend fun park(deviceMsgId: String, error: String, nowEpochMs: Long) {
            parkedIds += deviceMsgId
        }
        override suspend fun markRetry(
            deviceMsgIds: List<String>,
            nextAttemptAtEpochMs: Long,
            error: String?,
        ) = Unit
        override suspend fun unparkAll(nowEpochMs: Long) {
            unparkCount.incrementAndGet()
            parkedIds.clear()
        }
    }
}
