package com.sthuck.smsgateway.crypto

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
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
    fun pendingKeySignsAndCommitsWithoutCreatingInRequireSigner() {
        assertFalse(store.hasKey())
        try {
            store.requireSigner()
            fail("requireSigner must not create a key")
        } catch (_: IllegalStateException) {
            // expected
        } catch (_: Exception) {
            // error() throws IllegalStateException; accept any failure without create
            assertFalse(store.hasKey())
        }

        val spki = store.createPendingKeypair()
        assertTrue(store.hasPendingKey())
        assertFalse(store.hasKey())
        assertTrue(spki.isNotBlank())
        assertFalse(spki.contains('='))

        val publicKey = store.publicKey()
        assertEquals("EC", publicKey.algorithm)

        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val pendingAlias = if (ks.containsAlias(DeviceKeyStore.ALIAS_B)) {
            DeviceKeyStore.ALIAS_B
        } else {
            DeviceKeyStore.ALIAS_A
        }
        val entry = ks.getEntry(pendingAlias, null) as KeyStore.PrivateKeyEntry
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

        try {
            store.requireSigner()
            fail("requireSigner must not use the pending key")
        } catch (_: Exception) {
            // expected — committed key only
        }
        val signature = store.requirePendingSigner().sign(canonical)
        assertEquals(64, signature.size)
        assertTrue(verifyEs256P1363(publicKey, canonical, signature))
        assertNotNull(Base64Url.encode(signature))

        store.commitPendingKey()
        assertTrue(store.hasKey())
        assertFalse(store.hasPendingKey())
        assertTrue(verifyEs256P1363(store.publicKey(), canonical, store.requireSigner().sign(canonical)))
    }

    @Test
    fun discardPendingLeavesActiveUntouched() {
        store.createPendingKeypair()
        store.commitPendingKey()
        assertTrue(store.hasKey())
        val activeSpki = store.activePublicKeySpkiBase64Url()

        store.createPendingKeypair()
        assertTrue(store.hasPendingKey())
        store.discardPendingKey()
        assertFalse(store.hasPendingKey())
        assertTrue(store.hasKey())
        assertEquals(activeSpki, store.activePublicKeySpkiBase64Url())
    }

    @Test
    fun deleteRemovesAliases() {
        store.createPendingKeypair()
        store.commitPendingKey()
        assertTrue(store.hasKey())
        store.deleteKey()
        assertFalse(store.hasKey())
        assertFalse(store.hasPendingKey())
    }


    @Test
    fun newInstanceFindsCommittedKeyWithoutCreating() {
        store.createPendingKeypair()
        store.commitPendingKey()
        assertTrue(store.hasKey())

        val again = DeviceKeyStore()
        assertTrue(again.hasKey())
        val signer = again.requireSigner()
        assertNotNull(signer)
        assertTrue(again.hasKey())
        assertFalse(again.hasPendingKey())
    }

    @Test
    fun commitKeepsPreviousAliasUntilDeleteAndPreferredSurvivesProcessDeath() {
        store.createPendingKeypair()
        val firstAlias = store.commitPendingKey()
        assertEquals(firstAlias, store.currentActiveAlias())
        val firstSpki = store.activePublicKeySpkiBase64Url()

        store.createPendingKeypair()
        val previousBeforeCommit = store.currentActiveAlias()
        assertEquals(firstAlias, previousBeforeCommit)
        val secondAlias = store.commitPendingKey()
        assertTrue(secondAlias != firstAlias)

        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertTrue(ks.containsAlias(firstAlias))
        assertTrue(ks.containsAlias(secondAlias))

        // Crash window: both aliases exist; preferred must win after "process death".
        val restored = DeviceKeyStore()
        restored.restorePreferredActiveAlias(secondAlias)
        assertEquals(secondAlias, restored.currentActiveAlias())
        assertTrue(restored.activePublicKeySpkiBase64Url() != firstSpki)

        store.deleteKeyAlias(firstAlias)
        val ksAfter = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        assertFalse(ksAfter.containsAlias(firstAlias))
        assertTrue(ksAfter.containsAlias(secondAlias))
        assertEquals(secondAlias, store.currentActiveAlias())
    }

    private companion object {
        const val DeviceHeadersEmptySha =
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
}
