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
) {
    val isPaired: Boolean get() = !deviceId.isNullOrBlank()
}

interface PairingStateAccess {
    suspend fun current(): PairingCredentials
    suspend fun clearDeviceId()
    suspend fun savePairing(deviceId: String, serverUrl: String)
    suspend fun clearAll()
}

@Singleton
class PairingCredentialStore @Inject constructor(
    @ApplicationContext private val context: Context,
) : PairingStateAccess {
    private val deviceIdKey = stringPreferencesKey("device_id")
    private val serverUrlKey = stringPreferencesKey("server_url")

    val credentials: Flow<PairingCredentials> = context.pairingDataStore.data.map { prefs ->
        PairingCredentials(
            deviceId = prefs[deviceIdKey]?.takeIf { it.isNotBlank() },
            serverUrl = prefs[serverUrlKey] ?: BuildConfig.BACKEND_URL,
        )
    }

    override suspend fun current(): PairingCredentials = credentials.first()

    suspend fun setServerUrl(serverUrl: String) {
        context.pairingDataStore.edit { prefs ->
            prefs[serverUrlKey] = normalizeBaseUrl(serverUrl)
        }
    }

    override suspend fun savePairing(deviceId: String, serverUrl: String) {
        context.pairingDataStore.edit { prefs ->
            prefs[deviceIdKey] = deviceId
            prefs[serverUrlKey] = normalizeBaseUrl(serverUrl)
        }
    }

    /** Clears device id (and keeps server URL for re-pair). */
    override suspend fun clearDeviceId() {
        context.pairingDataStore.edit { prefs ->
            prefs.remove(deviceIdKey)
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
