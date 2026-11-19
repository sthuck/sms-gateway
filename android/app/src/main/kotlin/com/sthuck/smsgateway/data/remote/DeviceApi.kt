package com.sthuck.smsgateway.data.remote

import com.sthuck.smsgateway.data.remote.dto.DeviceStatus
import com.sthuck.smsgateway.data.remote.dto.MessageBatchRequest
import com.sthuck.smsgateway.data.remote.dto.MessageBatchResponse
import com.sthuck.smsgateway.data.remote.dto.PairRequest
import com.sthuck.smsgateway.data.remote.dto.PairResponse
import okhttp3.RequestBody
import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Tag
import retrofit2.http.Url

/**
 * Device-facing API from the STH-5 contract.
 *
 * Signing headers are added by [RequestSigningInterceptor] (STH-11).
 * Pairing omits `X-Device-Id`; the canonical DEVICE_ID field is empty.
 * Pair uses an absolute [Url] so the candidate server is per-call and never
 * rewrites unrelated traffic (uploader / status).
 */
interface DeviceApi {

    @POST
    suspend fun pair(
        @Url url: String,
        @Body body: PairRequest,
        @Tag pairAccessHeaders: PairAccessHeadersTag? = null,
    ): PairResponse

    @POST("v1/messages:batch")
    suspend fun ingestMessageBatch(@Body body: MessageBatchRequest): MessageBatchResponse

    @GET("v1/devices/me")
    suspend fun getDeviceMe(): DeviceStatus

    /**
     * Proposed heartbeat (STH-47). Backend may 404 until the draft ships;
     * [com.sthuck.smsgateway.keepalive.HeartbeatClient] treats that as ignore.
     * Pass an empty [RequestBody] so `X-Content-SHA256` is the empty digest.
     */
    @POST("v1/devices/me/heartbeat")
    suspend fun postHeartbeat(@Body body: RequestBody): Response<Unit>
}
