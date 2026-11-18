package com.sthuck.smsgateway.data.remote

import com.sthuck.smsgateway.crypto.Base64Url
import com.sthuck.smsgateway.crypto.CanonicalString
import com.sthuck.smsgateway.crypto.ClockSkewStore
import com.sthuck.smsgateway.crypto.DeviceKeyStore
import com.sthuck.smsgateway.crypto.DeviceSigner
import com.sthuck.smsgateway.data.remote.dto.Problem
import com.sthuck.smsgateway.data.remote.dto.ProblemCodes
import com.sthuck.smsgateway.pairing.PairingCredentialStore
import com.sthuck.smsgateway.pairing.PairingSession
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.Buffer
import java.security.MessageDigest
import java.security.SecureRandom
import javax.inject.Inject
import javax.inject.Provider
import javax.inject.Singleton

/**
 * Signs every device API request per STH-5 draft 2.
 * Retries once on `401 invalid_timestamp` after applying `server_time`.
 * Clears pairing on `device_unknown` / `device_revoked`.
 */
@Singleton
class RequestSigningInterceptor @Inject constructor(
    private val credentialStore: PairingCredentialStore,
    private val deviceKeyStore: DeviceKeyStore,
    private val clockSkewStore: ClockSkewStore,
    private val pairingSession: PairingSession,
    private val json: Json,
    private val signerProvider: Provider<DeviceSigner>,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val credentials = runBlocking { credentialStore.current() }
        val isPair = original.url.encodedPath.endsWith("/v1/devices/pair") ||
            original.url.encodedPath.endsWith("v1/devices/pair")

        if (!isPair && !credentials.isPaired) {
            return chain.proceed(original)
        }

        val bodyBytes = original.body?.let { readBodyBytes(it) } ?: ByteArray(0)
        val rebuiltBody = if (original.body == null) {
            null
        } else {
            bodyBytes.toRequestBody(original.body!!.contentType())
        }

        var request = sign(
            original = original.newBuilder().method(original.method, rebuiltBody).build(),
            bodyBytes = bodyBytes,
            deviceId = if (isPair) null else credentials.deviceId,
        )
        var response = chain.proceed(request)

        if (response.code == 401 || response.code == 403) {
            val problem = peekProblem(response)
            when (problem?.code) {
                ProblemCodes.INVALID_TIMESTAMP -> {
                    val serverTime = problem.serverTime
                        ?: parseHttpDateToUnixSeconds(response.header("Date"))
                    if (serverTime != null) {
                        response.close()
                        clockSkewStore.applyServerTime(serverTime)
                        val retryBody = if (original.body == null) {
                            null
                        } else {
                            bodyBytes.toRequestBody(original.body!!.contentType())
                        }
                        request = sign(
                            original = original.newBuilder().method(original.method, retryBody).build(),
                            bodyBytes = bodyBytes,
                            deviceId = if (isPair) null else credentials.deviceId,
                        )
                        response = chain.proceed(request)
                    }
                }
                ProblemCodes.DEVICE_UNKNOWN, ProblemCodes.DEVICE_REVOKED -> {
                    runBlocking {
                        credentialStore.clearDeviceId()
                        deviceKeyStore.deleteKey()
                        clockSkewStore.clear()
                    }
                    pairingSession.notifyRePairRequired()
                }
            }
        }
        return response
    }

    private fun sign(
        original: Request,
        bodyBytes: ByteArray,
        deviceId: String?,
    ): Request {
        val contentSha = sha256Hex(bodyBytes)
        val timestamp = clockSkewStore.nowUnixSeconds().toString()
        val nonce = newNonce()
        val host = original.url.host.let { h ->
            val port = original.url.port
            val defaultPort = if (original.url.scheme == "https") 443 else 80
            if (port != defaultPort) "$h:$port" else h
        }.lowercase()
        val path = original.url.encodedPath
        val query = "" // v1 device endpoints have no query
        val canonical = CanonicalString.build(
            method = original.method,
            path = path,
            query = query,
            host = host,
            deviceId = deviceId.orEmpty(),
            timestamp = timestamp,
            contentSha256 = contentSha,
            nonce = nonce,
        )
        val signature = Base64Url.encode(
            signerProvider.get().sign(canonical.toByteArray(Charsets.UTF_8)),
        )
        val builder = original.newBuilder()
            .header(DeviceHeaders.TIMESTAMP, timestamp)
            .header(DeviceHeaders.NONCE, nonce)
            .header(DeviceHeaders.CONTENT_SHA256, contentSha)
            .header(DeviceHeaders.SIGNATURE, signature)
            // Contract: bodies are signed over exact wire bytes; no Content-Encoding.
            .removeHeader("Content-Encoding")
            .removeHeader(DeviceHeaders.DEVICE_ID)
        if (!deviceId.isNullOrBlank()) {
            builder.header(DeviceHeaders.DEVICE_ID, deviceId)
        }
        return builder.build()
    }

    private fun peekProblem(response: Response): Problem? {
        val body = response.peekBody(64 * 1024).string()
        return try {
            json.decodeFromString<Problem>(body)
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        fun sha256Hex(bytes: ByteArray): String {
            val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
            return digest.joinToString("") { b -> "%02x".format(b) }
        }

        fun newNonce(): String {
            val bytes = ByteArray(16)
            SecureRandom().nextBytes(bytes)
            return Base64Url.encode(bytes)
        }

        fun readBodyBytes(body: RequestBody): ByteArray {
            val buffer = Buffer()
            body.writeTo(buffer)
            return buffer.readByteArray()
        }

        /** Parses an RFC 7231 `Date` header into Unix seconds, or null. */
        fun parseHttpDateToUnixSeconds(dateHeader: String?): Long? {
            if (dateHeader.isNullOrBlank()) return null
            return try {
                val format = java.text.SimpleDateFormat(
                    "EEE, dd MMM yyyy HH:mm:ss zzz",
                    java.util.Locale.US,
                )
                format.timeZone = java.util.TimeZone.getTimeZone("GMT")
                format.parse(dateHeader)?.time?.div(1000L)
            } catch (_: Exception) {
                null
            }
        }
    }
}
