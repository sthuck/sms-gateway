package com.sthuck.smsgateway.pairing

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.sthuck.smsgateway.BuildConfig
import com.sthuck.smsgateway.crypto.SecretBox
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import javax.inject.Inject
import javax.inject.Singleton

private val Context.pairingDataStore: DataStore<Preferences> by preferencesDataStore(
    name = "pairing_credentials",
)

data class PairingCredentials(
    val deviceId: String?,
    val serverUrl: String,
    /** Android Keystore alias for the committed signing key (STH-11 residual). */
    val activeKeyAlias: String? = null,
    /** Server-assigned device display name from pair / devices/me (STH-18). */
    val deviceName: String? = null,
    /** Epoch ms of the last accepted/duplicate batch upload (STH-18). */
    val lastSuccessfulSyncAtEpochMs: Long? = null,
    /** Decrypted custom access headers sent only to [serverUrl]'s origin (STH-61). */
    val accessHeaders: Map<String, String> = emptyMap(),
    /** Non-null when upload/probe is blocked by tunnel/proxy authentication (STH-61). */
    val tunnelAuthError: String? = null,
) {
    val isPaired: Boolean get() = !deviceId.isNullOrBlank()
}

/** Read-only pairing view used by the uploader (easy to fake in JVM tests). */
interface PairingCredentialsReader {
    suspend fun current(): PairingCredentials
}

interface PairingStateAccess : PairingCredentialsReader {
    suspend fun clearDeviceId()
    suspend fun savePairing(
        deviceId: String,
        serverUrl: String,
        activeKeyAlias: String,
        deviceName: String,
        accessHeaders: Map<String, String> = emptyMap(),
    )
    suspend fun updateDeviceName(deviceName: String)
    suspend fun recordSuccessfulSync(atEpochMs: Long)
    suspend fun recordTunnelAuthError(message: String?)
    suspend fun clearAll()
}

@Singleton
class PairingCredentialStore private constructor(
    private val dataStore: DataStore<Preferences>,
    private val secretBox: SecretBox,
) : PairingStateAccess {

    @Inject
    constructor(
        @ApplicationContext context: Context,
        secretBox: SecretBox,
    ) : this(context.pairingDataStore, secretBox)

    private val deviceIdKey = stringPreferencesKey("device_id")
    private val serverUrlKey = stringPreferencesKey("server_url")
    private val activeKeyAliasKey = stringPreferencesKey("active_key_alias")
    private val deviceNameKey = stringPreferencesKey("device_name")
    private val lastSuccessfulSyncKey = longPreferencesKey("last_successful_sync_at")
    private val accessHeadersEncKey = stringPreferencesKey("access_headers_enc")
    private val tunnelAuthErrorKey = stringPreferencesKey("tunnel_auth_error")

    val credentials: Flow<PairingCredentials> = dataStore.data.map { prefs ->
        PairingCredentials(
            deviceId = prefs[deviceIdKey]?.takeIf { it.isNotBlank() },
            serverUrl = prefs[serverUrlKey] ?: BuildConfig.BACKEND_URL,
            activeKeyAlias = prefs[activeKeyAliasKey]?.takeIf { it.isNotBlank() },
            deviceName = prefs[deviceNameKey]?.takeIf { it.isNotBlank() },
            lastSuccessfulSyncAtEpochMs = prefs[lastSuccessfulSyncKey],
            accessHeaders = readAccessHeaders(prefs[accessHeadersEncKey]),
            tunnelAuthError = prefs[tunnelAuthErrorKey]?.takeIf { it.isNotBlank() },
        )
    }

    override suspend fun current(): PairingCredentials = credentials.first()

    suspend fun setServerUrl(serverUrl: String) {
        dataStore.edit { prefs ->
            prefs[serverUrlKey] = normalizeBaseUrl(serverUrl)
        }
    }

    override suspend fun savePairing(
        deviceId: String,
        serverUrl: String,
        activeKeyAlias: String,
        deviceName: String,
        accessHeaders: Map<String, String>,
    ) {
        val encryptedHeaders = if (accessHeaders.isEmpty()) {
            null
        } else {
            val validated = when (val result = AccessHeadersValidator.validate(accessHeaders)) {
                is AccessHeadersValidator.Result.Ok -> result.headers
                is AccessHeadersValidator.Result.Err ->
                    throw IllegalArgumentException(result.message)
            }
            val compactJson = AccessHeadersValidator.encodeCompactJson(validated)
            secretBox.encrypt(compactJson.toByteArray(Charsets.UTF_8))
        }
        dataStore.edit { prefs ->
            prefs[deviceIdKey] = deviceId
            prefs[serverUrlKey] = normalizeBaseUrl(serverUrl)
            prefs[activeKeyAliasKey] = activeKeyAlias
            prefs[deviceNameKey] = deviceName
            if (encryptedHeaders != null) {
                prefs[accessHeadersEncKey] = encryptedHeaders
            } else {
                prefs.remove(accessHeadersEncKey)
            }
            prefs.remove(tunnelAuthErrorKey)
        }
    }

    override suspend fun updateDeviceName(deviceName: String) {
        if (deviceName.isBlank()) return
        dataStore.edit { prefs ->
            prefs[deviceNameKey] = deviceName
        }
    }

    override suspend fun recordSuccessfulSync(atEpochMs: Long) {
        dataStore.edit { prefs ->
            prefs[lastSuccessfulSyncKey] = atEpochMs
            prefs.remove(tunnelAuthErrorKey)
        }
    }

    override suspend fun recordTunnelAuthError(message: String?) {
        val cleaned = message?.trim()?.takeIf { it.isNotEmpty() }
        dataStore.edit { prefs ->
            if (cleaned != null) {
                prefs[tunnelAuthErrorKey] = cleaned
            } else {
                prefs.remove(tunnelAuthErrorKey)
            }
        }
    }

    /** Clears device id and encrypted access headers (keeps server URL for re-pair). */
    override suspend fun clearDeviceId() {
        dataStore.edit { prefs ->
            prefs.remove(deviceIdKey)
            prefs.remove(activeKeyAliasKey)
            prefs.remove(deviceNameKey)
            prefs.remove(lastSuccessfulSyncKey)
            prefs.remove(accessHeadersEncKey)
            prefs.remove(tunnelAuthErrorKey)
        }
    }

    override suspend fun clearAll() {
        dataStore.edit { it.clear() }
        secretBox.deleteKey()
    }

    private fun readAccessHeaders(encrypted: String?): Map<String, String> {
        if (encrypted.isNullOrBlank()) return emptyMap()
        val plaintextBytes = secretBox.decrypt(encrypted) ?: return emptyMap()
        val jsonText = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(plaintextBytes))
                .toString()
        } catch (_: Exception) {
            return emptyMap()
        }
        return when (val result = AccessHeadersValidator.decodePlainJson(jsonText)) {
            is AccessHeadersValidator.Result.Ok -> result.headers
            is AccessHeadersValidator.Result.Err -> emptyMap()
        }
    }

    companion object {
        internal fun createForTesting(
            dataStore: DataStore<Preferences>,
            secretBox: SecretBox,
        ): PairingCredentialStore = PairingCredentialStore(dataStore, secretBox)

        fun normalizeBaseUrl(url: String): String {
            return when (val result = ServerUrlValidator.validate(url)) {
                is ServerUrlValidator.Result.Ok -> result.value.url
                is ServerUrlValidator.Result.Err -> BuildConfig.BACKEND_URL.trimEnd('/')
            }
        }
    }
}
