package com.sthuck.smsgateway.data.remote

import com.sthuck.smsgateway.data.remote.dto.DeviceStatus
import com.sthuck.smsgateway.data.remote.dto.MessageBatchRequest
import com.sthuck.smsgateway.data.remote.dto.MessageBatchResponse
import com.sthuck.smsgateway.data.remote.dto.PairRequest
import com.sthuck.smsgateway.data.remote.dto.PairResponse
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

/**
 * Device-facing API from the STH-5 contract.
 *
 * Signing headers are added by [RequestSigningInterceptor] (STH-11).
 * Pairing omits `X-Device-Id`; the canonical DEVICE_ID field is empty.
 */
interface DeviceApi {

    @POST("v1/devices/pair")
    suspend fun pair(@Body body: PairRequest): PairResponse

    @POST("v1/messages:batch")
    suspend fun ingestMessageBatch(@Body body: MessageBatchRequest): MessageBatchResponse

    @GET("v1/devices/me")
    suspend fun getDeviceMe(): DeviceStatus
}
