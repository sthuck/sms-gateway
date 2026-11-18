package com.sthuck.smsgateway.crypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyStore

@RunWith(AndroidJUnit4::class)
class DeviceKeyStoreInstrumentedTest {

    private lateinit var store: DeviceKeyStore

    @Before
    fun setUp() {
        store = DeviceKeyStore()
        store.deleteKey()
    }

    @After
    fun tearDown() {
        store.deleteKey()
    }

    @Test
    fun generatesNonExportableEs256KeyAndSigns() {
        assertFalse(store.hasKey())
        val spki = store.getOrCreatePublicKeySpkiBase64Url()
        assertTrue(store.hasKey())
        assertTrue(spki.isNotBlank())
        assertFalse(spki.contains('='))

        val publicKey = store.publicKey()
        assertEquals("EC", publicKey.algorithm)

        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val entry = ks.getEntry(DeviceKeyStore.ALIAS, null) as KeyStore.PrivateKeyEntry
        // Android Keystore private keys are non-exportable: encoded material is null.
        assertNull(entry.privateKey.encoded)

        val canonical = CanonicalString.build(
            method = "POST",
            path = "/v1/devices/pair",
            query = "",
            host = "10.0.2.2:4010",
            deviceId = "",
            timestamp = "1794995160",
            contentSha256 = DeviceHeadersEmptySha,
            nonce = "V1nQe4r0sK8mP2yL6dF9TQ",
        ).toByteArray(Charsets.UTF_8)

        val signature = store.signer().sign(canonical)
        assertEquals(64, signature.size)
        assertTrue(verifyEs256P1363(publicKey, canonical, signature))
        assertNotNull(Base64Url.encode(signature))
    }

    @Test
    fun deleteRemovesAlias() {
        store.getOrCreatePublicKeySpkiBase64Url()
        assertTrue(store.hasKey())
        store.deleteKey()
        assertFalse(store.hasKey())
    }

    private companion object {
        const val DeviceHeadersEmptySha =
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
}
