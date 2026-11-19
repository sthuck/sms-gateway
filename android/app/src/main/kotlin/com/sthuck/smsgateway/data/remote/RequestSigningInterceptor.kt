package com.sthuck.smsgateway.data.remote

import com.sthuck.smsgateway.crypto.Base64Url
import com.sthuck.smsgateway.crypto.CanonicalString
import com.sthuck.smsgateway.crypto.ClockSkewStore
import com.sthuck.smsgateway.crypto.DeviceKeyAccess
import com.sthuck.smsgateway.crypto.DeviceSigner
import com.sthuck.smsgateway.data.remote.dto.Problem
import com.sthuck.smsgateway.data.remote.dto.ProblemCodes
import com.sthuck.smsgateway.pairing.DeviceRevocationHandler
import com.sthuck.smsgateway.pairing.PairingStateAccess
import com.sthuck.smsgateway.pairing.RePairReason
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
 * Clears pairing only on genuine `device_unknown` / `device_revoked`.
 * `invalid_signature` must NOT wipe credentials (STH-18) — resign/retry.
 * A paired device with a missing Keystore key is treated as re-pair required (M2).
 */
@Singleton
class RequestSigningInterceptor @Inject constructor(
    private val credentialStore: PairingStateAccess,
    private val deviceKeyStore: DeviceKeyAccess,
    private val clockSkewStore: ClockSkewStore,
    private val revocationHandler: DeviceRevocationHandler,
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

        if (!isPair && credentials.isPaired && !deviceKeyStore.hasKey()) {
            runBlocking {
                revocationHandler.wipeAndPromptRePair(RePairReason.KEY_MISSING)
            }
            return chain.proceed(original)
        }

        require(original.url.encodedQuery == null) {
            "Device API v1 requests must not include a query string (got ${original.url})"
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
            usePendingKey = isPair,
        )
        var response = chain.proceed(request)

        if (response.code == 401 || response.code == 403) {
            val problem = peekProblem(response)
            when (problem?.code) {
                ProblemCodes.INVALID_TIMESTAMP, ProblemCodes.REPLAY_DETECTED -> {
                    val serverTime = problem.serverTime
                        ?: parseHttpDateToUnixSeconds(response.header("Date"))
                    if (serverTime != null || problem.code == ProblemCodes.REPLAY_DETECTED) {
                        response.close()
                        if (serverTime != null) {
                            clockSkewStore.applyServerTime(serverTime)
                        }
                        val retryBody = if (original.body == null) {
                            null
                        } else {
                            bodyBytes.toRequestBody(original.body!!.contentType())
                        }
                        request = sign(
                            original = original.newBuilder().method(original.method, retryBody).build(),
                            bodyBytes = bodyBytes,
                            deviceId = if (isPair) null else credentials.deviceId,
                            usePendingKey = isPair,
                        )
                        response = chain.proceed(request)
                    }
                }
                ProblemCodes.DEVICE_UNKNOWN -> {
                    runBlocking {
                        revocationHandler.wipeAndPromptRePair(RePairReason.UNKNOWN)
                    }
                }
                ProblemCodes.DEVICE_REVOKED -> {
                    runBlocking {
                        revocationHandler.wipeAndPromptRePair(RePairReason.REVOKED)
                    }
                }
                ProblemCodes.INVALID_SIGNATURE -> {
                    // Keep credentials and outbox pending — resign on the next attempt (STH-18).
                }
            }
        }
        return response
    }

    private fun sign(
        original: Request,
        bodyBytes: ByteArray,
        deviceId: String?,
        usePendingKey: Boolean,
    ): Request {
        val contentSha = sha256Hex(bodyBytes)
        val timestamp = clockSkewStore.nowUnixSeconds().toString()
        val nonce = newNonce()
        val host = hostHeaderValue(original)
        val path = original.url.encodedPath
        val query = ""
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
        val signer = if (usePendingKey) {
            deviceKeyStore.requirePendingSigner()
        } else {
            signerProvider.get()
        }
        val signature = Base64Url.encode(
            signer.sign(canonical.toByteArray(Charsets.UTF_8)),
        )
        val builder = original.newBuilder()
            .header(DeviceHeaders.TIMESTAMP, timestamp)
            .header(DeviceHeaders.NONCE, nonce)
            .header(DeviceHeaders.CONTENT_SHA256, contentSha)
            .header(DeviceHeaders.SIGNATURE, signature)
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
        fun hostHeaderValue(request: Request): String {
            val url = request.url
            val defaultPort = if (url.scheme == "https") 443 else 80
            return if (url.port != defaultPort) {
                "${url.host}:${url.port}"
            } else {
                url.host
            }.lowercase()
        }

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
