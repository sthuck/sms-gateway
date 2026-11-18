package com.sthuck.smsgateway.data.remote

import com.sthuck.smsgateway.data.remote.dto.DeviceStatus
import com.sthuck.smsgateway.data.remote.dto.MessageBatchRequest
import com.sthuck.smsgateway.data.remote.dto.MessageBatchResponse
import com.sthuck.smsgateway.data.remote.dto.PairRequest
import com.sthuck.smsgateway.data.remote.dto.PairResponse
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
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
    suspend fun pair(@Url url: String, @Body body: PairRequest): PairResponse

    @POST("v1/messages:batch")
    suspend fun ingestMessageBatch(@Body body: MessageBatchRequest): MessageBatchResponse

    @GET("v1/devices/me")
    suspend fun getDeviceMe(): DeviceStatus
}
