package com.sthuck.smsgateway.pairing

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.sthuck.smsgateway.BuildConfig
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
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
) {
    val isPaired: Boolean get() = !deviceId.isNullOrBlank()
}

/** Read-only pairing view used by the uploader (easy to fake in JVM tests). */
interface PairingCredentialsReader {
    suspend fun current(): PairingCredentials
}

interface PairingStateAccess : PairingCredentialsReader {
    suspend fun clearDeviceId()
    suspend fun savePairing(deviceId: String, serverUrl: String, activeKeyAlias: String)
    suspend fun clearAll()
}

@Singleton
class PairingCredentialStore @Inject constructor(
    @ApplicationContext private val context: Context,
) : PairingStateAccess {
    private val deviceIdKey = stringPreferencesKey("device_id")
    private val serverUrlKey = stringPreferencesKey("server_url")
    private val activeKeyAliasKey = stringPreferencesKey("active_key_alias")

    val credentials: Flow<PairingCredentials> = context.pairingDataStore.data.map { prefs ->
        PairingCredentials(
            deviceId = prefs[deviceIdKey]?.takeIf { it.isNotBlank() },
            serverUrl = prefs[serverUrlKey] ?: BuildConfig.BACKEND_URL,
            activeKeyAlias = prefs[activeKeyAliasKey]?.takeIf { it.isNotBlank() },
        )
    }

    override suspend fun current(): PairingCredentials = credentials.first()

    suspend fun setServerUrl(serverUrl: String) {
        context.pairingDataStore.edit { prefs ->
            prefs[serverUrlKey] = normalizeBaseUrl(serverUrl)
        }
    }

    override suspend fun savePairing(deviceId: String, serverUrl: String, activeKeyAlias: String) {
        context.pairingDataStore.edit { prefs ->
            prefs[deviceIdKey] = deviceId
            prefs[serverUrlKey] = normalizeBaseUrl(serverUrl)
            prefs[activeKeyAliasKey] = activeKeyAlias
        }
    }

    /** Clears device id (and keeps server URL for re-pair). */
    override suspend fun clearDeviceId() {
        context.pairingDataStore.edit { prefs ->
            prefs.remove(deviceIdKey)
            prefs.remove(activeKeyAliasKey)
        }
    }

    override suspend fun clearAll() {
        context.pairingDataStore.edit { it.clear() }
    }

    companion object {
        fun normalizeBaseUrl(url: String): String {
            return when (val result = ServerUrlValidator.validate(url)) {
                is ServerUrlValidator.Result.Ok -> result.value.url
                is ServerUrlValidator.Result.Err -> BuildConfig.BACKEND_URL.trimEnd('/')
            }
        }
    }
}
