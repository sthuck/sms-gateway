package com.sthuck.smsgateway.pairing

import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.stringPreferencesKey
import com.sthuck.smsgateway.crypto.Base64Url
import com.sthuck.smsgateway.crypto.SecretBox
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PairingCredentialStoreTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    private lateinit var scope: CoroutineScope
    private lateinit var fakeBox: FakeSecretBox
    private lateinit var store: PairingCredentialStore
    private lateinit var rawDataStore: androidx.datastore.core.DataStore<androidx.datastore.preferences.core.Preferences>

    @Before
    fun setUp() {
        scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        rawDataStore = PreferenceDataStoreFactory.create(
            scope = scope,
            produceFile = { tempFolder.newFile("pairing_creds.preferences_pb") },
        )
        fakeBox = FakeSecretBox()
        store = PairingCredentialStore.createForTesting(rawDataStore, fakeBox)
    }

    @After
    fun tearDown() {
        scope.cancel()
    }

    @Test
    fun storesAccessHeadersEncryptedAtRestAndDecryptsOnRead() = runBlocking {
        val headers = mapOf(
            "CF-Access-Client-Id" to "client-123",
            "CF-Access-Client-Secret" to "secret-xyz",
        )
        store.savePairing(
            deviceId = "dev-1",
            serverUrl = "https://sms.sthuck.info",
            activeKeyAlias = "alias_a",
            deviceName = "Pixel",
            accessHeaders = headers,
        )

        val rawPrefs = rawDataStore.data.first()
        val storedCiphertext = rawPrefs[stringPreferencesKey("access_headers_enc")]
        assertNotNull(storedCiphertext)
        assertFalse(storedCiphertext!!.contains("secret-xyz"))
        assertFalse(storedCiphertext.contains("CF-Access-Client-Secret"))
        assertTrue(storedCiphertext.startsWith("fake-enc:"))

        val creds = store.current()
        assertEquals(headers, creds.accessHeaders)
        assertNull(creds.tunnelAuthError)
    }

    @Test
    fun corruptCiphertextSafelyYieldsEmptyHeaders() = runBlocking {
        store.savePairing(
            deviceId = "dev-1",
            serverUrl = "https://sms.sthuck.info",
            activeKeyAlias = "alias_a",
            deviceName = "Pixel",
            accessHeaders = mapOf("CF-Access-Client-Id" to "id"),
        )
        fakeBox.failDecrypt = true
        assertEquals(emptyMap<String, String>(), store.current().accessHeaders)
    }

    @Test
    fun rePairingWithoutHeadersRemovesPreviousHeadersAndClearsTunnelError() = runBlocking {
        store.savePairing(
            deviceId = "dev-1",
            serverUrl = "https://sms.sthuck.info",
            activeKeyAlias = "alias_a",
            deviceName = "Pixel",
            accessHeaders = mapOf("CF-Access-Client-Id" to "old-id"),
        )
        store.recordTunnelAuthError("HTTP 403")
        assertEquals("HTTP 403", store.current().tunnelAuthError)

        store.savePairing(
            deviceId = "dev-2",
            serverUrl = "https://other.example",
            activeKeyAlias = "alias_b",
            deviceName = "Pixel 2",
            accessHeaders = emptyMap(),
        )
        val creds = store.current()
        assertEquals(emptyMap<String, String>(), creds.accessHeaders)
        assertNull(creds.tunnelAuthError)
        assertNull(rawDataStore.data.first()[stringPreferencesKey("access_headers_enc")])
    }

    @Test
    fun clearDeviceIdRemovesHeadersAndTunnelErrorWhileKeepingServerUrl() = runBlocking {
        store.savePairing(
            deviceId = "dev-1",
            serverUrl = "https://custom.example",
            activeKeyAlias = "alias_a",
            deviceName = "Pixel",
            accessHeaders = mapOf("CF-Access-Client-Id" to "id"),
        )
        store.recordTunnelAuthError("HTTP 302")
        store.clearDeviceId()

        val creds = store.current()
        assertNull(creds.deviceId)
        assertEquals("https://custom.example", creds.serverUrl)
        assertEquals(emptyMap<String, String>(), creds.accessHeaders)
        assertNull(creds.tunnelAuthError)
        assertFalse(fakeBox.deleted)
    }

    @Test
    fun clearAllRemovesEverythingAndDeletesKeystoreKey() = runBlocking {
        store.savePairing(
            deviceId = "dev-1",
            serverUrl = "https://custom.example",
            activeKeyAlias = "alias_a",
            deviceName = "Pixel",
            accessHeaders = mapOf("CF-Access-Client-Id" to "id"),
        )
        store.recordTunnelAuthError("HTTP 403")
        store.clearAll()

        val creds = store.current()
        assertNull(creds.deviceId)
        assertEquals(emptyMap<String, String>(), creds.accessHeaders)
        assertNull(creds.tunnelAuthError)
        assertTrue(fakeBox.deleted)
    }

    @Test
    fun recordSuccessfulSyncClearsTunnelAuthError() = runBlocking {
        store.savePairing(
            deviceId = "dev-1",
            serverUrl = "https://custom.example",
            activeKeyAlias = "alias_a",
            deviceName = "Pixel",
        )
        store.recordTunnelAuthError("HTTP 403")
        assertEquals("HTTP 403", store.current().tunnelAuthError)

        store.recordSuccessfulSync(12345L)
        val creds = store.current()
        assertEquals(12345L, creds.lastSuccessfulSyncAtEpochMs)
        assertNull(creds.tunnelAuthError)
    }

    private class FakeSecretBox : SecretBox {
        var failDecrypt = false
        var deleted = false

        override fun encrypt(plaintext: ByteArray): String {
            val xor = plaintext.map { (it.toInt() xor 0x5A).toByte() }.toByteArray()
            return "fake-enc:" + Base64Url.encode(xor)
        }

        override fun decrypt(ciphertext: String): ByteArray? {
            if (failDecrypt || !ciphertext.startsWith("fake-enc:")) return null
            val raw = Base64Url.decode(ciphertext.removePrefix("fake-enc:"))
            return raw.map { (it.toInt() xor 0x5A).toByte() }.toByteArray()
        }

        override fun deleteKey() {
            deleted = true
        }
    }
}
