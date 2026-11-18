package com.sthuck.smsgateway.upload

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sthuck.smsgateway.data.local.AppDatabase
import com.sthuck.smsgateway.data.local.QueuedMessageEntity
import com.sthuck.smsgateway.data.remote.DeviceApi
import com.sthuck.smsgateway.data.remote.dto.ProblemCodes
import com.sthuck.smsgateway.pairing.PairingCredentials
import com.sthuck.smsgateway.pairing.PairingCredentialsReader
import com.sthuck.smsgateway.pairing.PairingSession
import com.sthuck.smsgateway.testing.DeviceApiMock
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory

@RunWith(AndroidJUnit4::class)
class OutboxUploaderInstrumentedTest {

    private lateinit var db: AppDatabase
    private lateinit var server: MockWebServer
    private lateinit var uploader: OutboxUploader
    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        namingStrategy = JsonNamingStrategy.SnakeCase
    }

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            AppDatabase::class.java,
        ).build()
        server = MockWebServer()
        server.start()
        val api = Retrofit.Builder()
            .baseUrl(server.url("/"))
            .client(OkHttpClient())
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(DeviceApi::class.java)
        val credentials = object : PairingCredentialsReader {
            override suspend fun current() = PairingCredentials(
                deviceId = DeviceApiMock.SAMPLE_DEVICE_ID,
                serverUrl = server.url("/").toString(),
            )
        }
        val dao = db.queuedMessageDao()
        uploader = OutboxUploader(
            dao = dao,
            deviceApi = api,
            credentialStore = credentials,
            pairingSession = PairingSession(),
            json = json,
            housekeeping = OutboxHousekeeping(dao),
        )
    }

    @After
    fun tearDown() {
        db.close()
        server.shutdown()
    }

    @Test
    fun retryThenAccept() = runBlocking {
        db.queuedMessageDao().insert(
            QueuedMessageEntity(
                deviceMsgId = "sms-42",
                contentKey = "k",
                sender = "+15551234567",
                body = "code",
                receivedAt = "2026-11-18T09:45:12Z",
                direction = "inbound",
                createdAtEpochMs = 1L,
            ),
        )
        DeviceApiMock.enqueueProblem(
            server,
            httpCode = 503,
            code = ProblemCodes.SERVICE_UNAVAILABLE,
            title = "unavailable",
            detail = "try later",
            retryable = true,
        )
        val first = uploader.runOnce(nowEpochMs = 1_000L)
        assertTrue(first is UploadPassResult.RetryLater)
        assertEquals(1, db.queuedMessageDao().getAll().single().attemptCount)

        DeviceApiMock.enqueueBatchAccepted(server, deviceMsgId = "sms-42")
        // Force ready by using a future "now".
        val row = db.queuedMessageDao().getAll().single()
        val second = uploader.runOnce(nowEpochMs = row.nextAttemptAtEpochMs + 1)
        assertTrue(second is UploadPassResult.Idle)
        assertTrue(db.queuedMessageDao().getAll().isEmpty())
    }

    @Test
    fun revokeStopsAndLeavesQueue() = runBlocking {
        db.queuedMessageDao().insert(
            QueuedMessageEntity(
                deviceMsgId = "sms-1",
                contentKey = "k",
                sender = "+15551234567",
                body = "code",
                receivedAt = "2026-11-18T09:45:12Z",
                direction = "inbound",
                createdAtEpochMs = 1L,
            ),
        )
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
        assertEquals(1, db.queuedMessageDao().getAll().size)
    }
}
