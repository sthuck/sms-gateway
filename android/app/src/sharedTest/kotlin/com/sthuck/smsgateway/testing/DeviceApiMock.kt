package com.sthuck.smsgateway.testing

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

/**
 * Small MockWebServer helper aligned with STH-5 v1 draft 2
 * (`docs/contracts/device-api.yaml`). It does not verify ES256 signatures;
 * it only serves the documented example payloads and problem+json errors.
 */
object DeviceApiMock {
    const val SAMPLE_DEVICE_ID = "018f3c2a-9b4d-7e21-a456-426614174000"
    const val SAMPLE_SERVER_MESSAGE_ID = "0191a0b0-1111-7000-8000-000000000001"
    const val SAMPLE_DEVICE_NAME = "Google Pixel 8"
    const val EMPTY_BODY_SHA256 =
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

    fun dispatcher(
        deviceStatus: String = "active",
        batchDeviceMsgId: String = "sms-42",
    ): Dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.path?.substringBefore("?") ?: ""
            return when {
                request.method == "POST" && path == "/v1/devices/pair" -> pairCreated()
                request.method == "POST" && path == "/v1/messages:batch" ->
                    batchAccepted(batchDeviceMsgId)
                request.method == "GET" && path == "/v1/devices/me" ->
                    deviceMe(deviceStatus)
                request.method == "POST" && path == "/v1/devices/me/heartbeat" ->
                    heartbeatNoContent()
                else -> problem(
                    httpCode = 404,
                    code = "invalid_request",
                    title = "Not found",
                    detail = "No mock for ${request.method} $path",
                    retryable = false,
                    instance = path,
                )
            }
        }
    }

    fun enqueuePairCreated(server: MockWebServer): Unit = server.enqueue(pairCreated())

    fun enqueueBatchAccepted(
        server: MockWebServer,
        deviceMsgId: String = "sms-42",
    ): Unit = server.enqueue(batchAccepted(deviceMsgId))

    fun enqueueDeviceMe(
        server: MockWebServer,
        status: String = "active",
    ): Unit = server.enqueue(deviceMe(status))

    fun enqueueHeartbeatNoContent(server: MockWebServer): Unit =
        server.enqueue(heartbeatNoContent())

    fun enqueueProblem(
        server: MockWebServer,
        httpCode: Int,
        code: String,
        title: String,
        detail: String,
        retryable: Boolean,
        instance: String = "/v1/messages:batch",
        serverTime: Long? = null,
        dateHeader: String? = null,
    ): Unit = server.enqueue(
        problem(httpCode, code, title, detail, retryable, instance, serverTime, dateHeader),
    )

    fun pairCreated(): MockResponse = json(
        201,
        """
        {
          "device_id": "$SAMPLE_DEVICE_ID",
          "name": "$SAMPLE_DEVICE_NAME",
          "status": "active",
          "paired_at": "2026-11-18T09:46:00Z"
        }
        """.trimIndent(),
    )

    fun batchAccepted(deviceMsgId: String = "sms-42"): MockResponse = json(
        200,
        """
        {
          "results": [
            {
              "device_msg_id": "$deviceMsgId",
              "status": "accepted",
              "id": "$SAMPLE_SERVER_MESSAGE_ID"
            }
          ]
        }
        """.trimIndent(),
    )

    fun heartbeatNoContent(): MockResponse =
        MockResponse().setResponseCode(204)

    fun deviceMe(status: String = "active"): MockResponse {
        val revoked = if (status == "revoked") {
            ",\n          \"revoked_at\": \"2026-11-18T09:30:00Z\""
        } else {
            ""
        }
        return json(
            200,
            """
            {
              "device_id": "$SAMPLE_DEVICE_ID",
              "name": "$SAMPLE_DEVICE_NAME",
              "status": "$status",
              "paired_at": "2026-11-18T09:00:00Z",
              "last_seen_at": "2026-11-18T09:46:00Z"$revoked
            }
            """.trimIndent(),
        )
    }

    fun problem(
        httpCode: Int,
        code: String,
        title: String,
        detail: String,
        retryable: Boolean,
        instance: String,
        serverTime: Long? = null,
        dateHeader: String? = null,
    ): MockResponse {
        val serverTimeField = if (serverTime != null) {
            ",\n              \"server_time\": $serverTime"
        } else {
            ""
        }
        val response = MockResponse()
            .setResponseCode(httpCode)
            .addHeader("Content-Type", "application/problem+json")
            .setBody(
                """
                {
                  "type": "https://sms-gateway.example/problems/$code",
                  "title": "$title",
                  "status": $httpCode,
                  "detail": "$detail",
                  "instance": "$instance",
                  "code": "$code",
                  "retryable": $retryable$serverTimeField
                }
                """.trimIndent(),
            )
        if (dateHeader != null) {
            response.addHeader("Date", dateHeader)
        }
        return response
    }

    private fun json(code: Int, body: String): MockResponse =
        MockResponse()
            .setResponseCode(code)
            .addHeader("Content-Type", "application/json")
            .setBody(body)
}
