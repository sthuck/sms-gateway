package com.sthuck.smsgateway.pairing

import android.os.Build
import com.sthuck.smsgateway.BuildConfig
import com.sthuck.smsgateway.crypto.DeviceKeyAccess
import com.sthuck.smsgateway.data.local.QueuedMessageDao
import com.sthuck.smsgateway.data.remote.DeviceApi
import com.sthuck.smsgateway.data.remote.dto.DeviceInfo
import com.sthuck.smsgateway.data.remote.dto.PairRequest
import com.sthuck.smsgateway.data.remote.dto.Problem
import com.sthuck.smsgateway.data.remote.dto.ProblemCodes
import kotlinx.serialization.json.Json
import retrofit2.HttpException
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.cancellation.CancellationException

sealed class PairingResult {
    data class Success(val deviceId: String, val serverUrl: String) : PairingResult()
    data class Failure(val message: String, val code: String? = null) : PairingResult()
}

@Singleton
class PairingRepository @Inject constructor(
    private val deviceApi: DeviceApi,
    private val deviceKeyStore: DeviceKeyAccess,
    private val credentialStore: PairingStateAccess,
    private val queuedMessageDao: QueuedMessageDao,
    private val json: Json,
) {
    /**
     * Pair using a validated server URL. Does not mutate existing credentials
     * or the active Keystore key until the server returns success (STH-44).
     *
     * The candidate server is passed as an absolute Retrofit `@Url` for this
     * call only — never via a process-global override.
     *
     * On success the pending Keystore key is committed before credentials are
     * saved, so a crash cannot leave a device id without its signing key.
     */
    suspend fun pair(code: String, serverUrl: String): PairingResult {
        val validated = when (val result = ServerUrlValidator.validate(serverUrl)) {
            is ServerUrlValidator.Result.Ok -> result.value
            is ServerUrlValidator.Result.Err ->
                return PairingResult.Failure(result.message)
        }

        val publicKey = try {
            deviceKeyStore.createPendingKeypair()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return PairingResult.Failure(
                message = (e.message ?: "Could not create device key.").take(180),
            )
        }

        return try {
            val response = deviceApi.pair(
                url = pairEndpoint(validated.url),
                body = PairRequest(
                    pairingCode = code,
                    publicKey = publicKey,
                    deviceInfo = DeviceInfo(
                        appVersion = BuildConfig.VERSION_NAME,
                        name = listOf(Build.MANUFACTURER, Build.MODEL)
                            .joinToString(" ")
                            .trim()
                            .ifEmpty { Build.MODEL },
                        manufacturer = Build.MANUFACTURER,
                        model = Build.MODEL,
                        osVersion = Build.VERSION.RELEASE,
                        sdkInt = Build.VERSION.SDK_INT,
                    ),
                ),
            )
            // Key first, then credentials: never persist a device id without a key.
            deviceKeyStore.commitPendingKey()
            credentialStore.savePairing(
                deviceId = response.deviceId,
                serverUrl = validated.url,
            )
            PairingResult.Success(deviceId = response.deviceId, serverUrl = validated.url)
        } catch (e: CancellationException) {
            deviceKeyStore.discardPendingKey()
            throw e
        } catch (e: HttpException) {
            deviceKeyStore.discardPendingKey()
            val problem = e.response()?.errorBody()?.string()?.let { body ->
                runCatching { json.decodeFromString<Problem>(body) }.getOrNull()
            }
            val message = when (problem?.code) {
                ProblemCodes.INVALID_PAIRING_CODE ->
                    "That pairing code is invalid, expired, or already used."
                ProblemCodes.INVALID_PUBLIC_KEY ->
                    "Device key was rejected. Try pairing again."
                else -> {
                    val detail = problem?.detail ?: problem?.title
                        ?: "Pairing failed (${e.code()})."
                    detail.take(180)
                }
            }
            PairingResult.Failure(message = message, code = problem?.code)
        } catch (e: Exception) {
            deviceKeyStore.discardPendingKey()
            PairingResult.Failure(message = (e.message ?: "Pairing failed.").take(180))
        }
    }

    suspend fun unpair(clearQueue: Boolean) {
        credentialStore.clearAll()
        deviceKeyStore.deleteKey()
        if (clearQueue) {
            queuedMessageDao.deleteAll()
        }
    }

    companion object {
        fun pairEndpoint(baseUrl: String): String =
            baseUrl.trimEnd('/') + "/v1/devices/pair"
    }
}
