package com.sthuck.smsgateway.pairing

import android.os.Build
import com.sthuck.smsgateway.BuildConfig
import com.sthuck.smsgateway.crypto.DeviceKeyStore
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

sealed class PairingResult {
    data class Success(val deviceId: String, val serverUrl: String) : PairingResult()
    data class Failure(val message: String, val code: String? = null) : PairingResult()
}

@Singleton
class PairingRepository @Inject constructor(
    private val deviceApi: DeviceApi,
    private val deviceKeyStore: DeviceKeyStore,
    private val credentialStore: PairingCredentialStore,
    private val queuedMessageDao: QueuedMessageDao,
    private val json: Json,
) {
    suspend fun pair(rawInput: String, fallbackServerUrl: String? = null): PairingResult {
        val parsed = PairingUriParser.parse(rawInput)
            ?: return PairingResult.Failure(
                "Enter a valid pairing code (e.g. 7K3M-9Q2P) or scan the QR.",
            )
        val serverUrl = PairingCredentialStore.normalizeBaseUrl(
            parsed.serverUrl
                ?: fallbackServerUrl
                ?: credentialStore.current().serverUrl,
        )
        // Point BackendUrlInterceptor at the target before the signed pair call.
        credentialStore.setServerUrl(serverUrl)
        credentialStore.clearDeviceId()

        return try {
            deviceKeyStore.deleteKey()
            val publicKey = deviceKeyStore.getOrCreatePublicKeySpkiBase64Url()
            val response = deviceApi.pair(
                PairRequest(
                    pairingCode = parsed.code,
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
            credentialStore.savePairing(deviceId = response.deviceId, serverUrl = serverUrl)
            PairingResult.Success(deviceId = response.deviceId, serverUrl = serverUrl)
        } catch (e: HttpException) {
            deviceKeyStore.deleteKey()
            val problem = e.response()?.errorBody()?.string()?.let { body ->
                runCatching { json.decodeFromString<Problem>(body) }.getOrNull()
            }
            val message = when (problem?.code) {
                ProblemCodes.INVALID_PAIRING_CODE ->
                    "That pairing code is invalid, expired, or already used."
                ProblemCodes.INVALID_PUBLIC_KEY ->
                    "Device key was rejected. Try pairing again."
                else -> problem?.detail ?: problem?.title ?: "Pairing failed (${e.code()})."
            }
            PairingResult.Failure(message = message, code = problem?.code)
        } catch (e: Exception) {
            deviceKeyStore.deleteKey()
            PairingResult.Failure(message = e.message ?: "Pairing failed.")
        }
    }

    suspend fun unpair(clearQueue: Boolean) {
        credentialStore.clearAll()
        deviceKeyStore.deleteKey()
        if (clearQueue) {
            queuedMessageDao.deleteAll()
        }
    }
}
