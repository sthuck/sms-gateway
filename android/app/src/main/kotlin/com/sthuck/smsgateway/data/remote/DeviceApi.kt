package com.sthuck.smsgateway.data.remote

import com.sthuck.smsgateway.data.remote.dto.DeviceStatus
import com.sthuck.smsgateway.data.remote.dto.MessageBatchRequest
import com.sthuck.smsgateway.data.remote.dto.MessageBatchResponse
import com.sthuck.smsgateway.data.remote.dto.PairRequest
import com.sthuck.smsgateway.data.remote.dto.PairResponse
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.Header
import retrofit2.http.POST

/**
 * Device-facing API from the STH-5 contract.
 *
 * All requests are signed (ES256). Pairing omits [DeviceHeaders.DEVICE_ID];
 * the canonical DEVICE_ID field is empty for that call.
 */
interface DeviceApi {

    @POST("v1/devices/pair")
    suspend fun pair(
        @Header(DeviceHeaders.TIMESTAMP) timestamp: String,
        @Header(DeviceHeaders.NONCE) nonce: String,
        @Header(DeviceHeaders.CONTENT_SHA256) contentSha256: String,
        @Header(DeviceHeaders.SIGNATURE) signature: String,
        @Body body: PairRequest,
    ): PairResponse

    @POST("v1/messages:batch")
    suspend fun ingestMessageBatch(
        @Header(DeviceHeaders.DEVICE_ID) deviceId: String,
        @Header(DeviceHeaders.TIMESTAMP) timestamp: String,
        @Header(DeviceHeaders.NONCE) nonce: String,
        @Header(DeviceHeaders.CONTENT_SHA256) contentSha256: String,
        @Header(DeviceHeaders.SIGNATURE) signature: String,
        @Body body: MessageBatchRequest,
    ): MessageBatchResponse

    @GET("v1/devices/me")
    suspend fun getDeviceMe(
        @Header(DeviceHeaders.DEVICE_ID) deviceId: String,
        @Header(DeviceHeaders.TIMESTAMP) timestamp: String,
        @Header(DeviceHeaders.NONCE) nonce: String,
        @Header(DeviceHeaders.CONTENT_SHA256) contentSha256: String,
        @Header(DeviceHeaders.SIGNATURE) signature: String,
    ): DeviceStatus
}
