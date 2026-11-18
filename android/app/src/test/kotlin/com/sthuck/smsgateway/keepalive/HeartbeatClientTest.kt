package com.sthuck.smsgateway.keepalive

import com.sthuck.smsgateway.BuildConfig
import com.sthuck.smsgateway.data.remote.DeviceApi
import com.sthuck.smsgateway.data.remote.dto.DeviceStatus
import com.sthuck.smsgateway.data.remote.dto.MessageBatchRequest
import com.sthuck.smsgateway.data.remote.dto.MessageBatchResponse
import com.sthuck.smsgateway.data.remote.dto.PairRequest
import com.sthuck.smsgateway.data.remote.dto.PairResponse
import kotlinx.coroutines.test.runTest
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import retrofit2.HttpException
import retrofit2.Response
import java.io.IOException

class HeartbeatClientTest {

    @Test
    fun buildConfigDefaultsHeartbeatOff() {
        assertFalse(
            "HEARTBEAT_ENABLED must default false until the backend ships",
            BuildConfig.HEARTBEAT_ENABLED,
        )
    }

    @Test
    fun disabledSkipsNetwork() = runTest {
        val api = RecordingDeviceApi()
        val client = HeartbeatClient(api)
        assertEquals(HeartbeatOutcome.Disabled, client.send(enabledOverride = false))
        assertEquals(0, api.heartbeatCalls)
    }

    @Test
    fun successWhenEnabled() = runTest {
        val api = RecordingDeviceApi()
        assertEquals(HeartbeatOutcome.Ok, HeartbeatClient(api).send(enabledOverride = true))
        assertEquals(1, api.heartbeatCalls)
        assertEquals(0, api.heartbeatBody!!.contentLength())
    }

    @Test
    fun http404IsRetryableIgnored() = runTest {
        val api = RecordingDeviceApi(heartbeatResponse = { throw http(404) })
        assertEquals(
            HeartbeatOutcome.RetryableIgnored,
            HeartbeatClient(api).send(enabledOverride = true),
        )
    }

    @Test
    fun http503IsRetryableIgnored() = runTest {
        val api = RecordingDeviceApi(heartbeatResponse = { throw http(503) })
        assertEquals(
            HeartbeatOutcome.RetryableIgnored,
            HeartbeatClient(api).send(enabledOverride = true),
        )
    }

    @Test
    fun transportErrorsAreRetryableIgnored() = runTest {
        val api = RecordingDeviceApi(heartbeatResponse = { throw IOException("offline") })
        assertEquals(
            HeartbeatOutcome.RetryableIgnored,
            HeartbeatClient(api).send(enabledOverride = true),
        )
    }

    private fun http(code: Int): HttpException =
        HttpException(
            Response.error<Unit>(
                code,
                "{}".toResponseBody("application/json".toMediaType()),
            ),
        )

    private class RecordingDeviceApi(
        private val heartbeatResponse: suspend () -> Response<Unit> = {
            Response.success(204, Unit)
        },
    ) : DeviceApi {
        var heartbeatCalls: Int = 0
            private set
        var heartbeatBody: RequestBody? = null
            private set

        override suspend fun pair(url: String, body: PairRequest): PairResponse =
            error("unused")

        override suspend fun ingestMessageBatch(body: MessageBatchRequest): MessageBatchResponse =
            error("unused")

        override suspend fun getDeviceMe(): DeviceStatus = error("unused")

        override suspend fun postHeartbeat(body: RequestBody): Response<Unit> {
            heartbeatCalls++
            heartbeatBody = body
            return heartbeatResponse()
        }
    }
}
