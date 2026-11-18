package com.sthuck.smsgateway.crypto

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.cert.Certificate
import java.util.concurrent.atomic.AtomicReference
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Non-exportable ES256 (P-256) keypair in Android Keystore.
 * Tries StrongBox first, falls back to TEE/software-backed Keystore.
 *
 * Active vs pending aliases keep pairing transactional: a new key is
 * generated under a pending alias and only promoted after a successful
 * `POST /v1/devices/pair`. [requireSigner] never creates a key.
 *
 * The active alias is rediscovered from Keystore after process death
 * (in-memory [activeAlias] is only a cache).
 */
interface DeviceKeyAccess {
    fun hasKey(): Boolean
    fun hasPendingKey(): Boolean
    fun deleteKey()
    /** Committed (active) key only — never the in-flight pending pair key. */
    fun requireSigner(): DeviceSigner
    /** Pending pair key only; used exclusively while signing `POST .../pair`. */
    fun requirePendingSigner(): DeviceSigner
    fun createPendingKeypair(): String
    fun commitPendingKey()
    fun discardPendingKey()
}

@Singleton
class DeviceKeyStore @Inject constructor() : DeviceKeyAccess {

    private val pendingAlias = AtomicReference<String?>(null)
    private val activeAlias = AtomicReference<String?>(null)

    override fun hasKey(): Boolean = committedAlias() != null

    override fun hasPendingKey(): Boolean = pendingAlias.get()?.let { contains(it) } == true

    /**
     * Signer for the committed key only. Never creates a key and never
     * returns the in-flight pending pair key (uploader/status stay on the
     * previously committed key).
     */
    override fun requireSigner(): DeviceSigner {
        val alias = committedAlias() ?: error("Device signing key missing")
        return signerForAlias(alias)
    }

    /** Signer for the pending pair key. Never creates a key. */
    override fun requirePendingSigner(): DeviceSigner {
        val alias = pendingAlias.get()?.takeIf { contains(it) }
            ?: error("Pending device signing key missing")
        return signerForAlias(alias)
    }

    fun publicKey(): PublicKey {
        val alias = pendingAlias.get()?.takeIf { contains(it) }
            ?: committedAlias()
            ?: error("Device public key missing")
        return requirePublicKey(alias)
    }

    private fun signerForAlias(alias: String): DeviceSigner {
        val privateKey = androidKeyStore().getKey(alias, null) as? PrivateKey
            ?: error("Device signing key missing for alias=$alias")
        return PrivateKeyDeviceSigner(privateKey)
    }

    /** SPKI of the active (committed) key only. */
    fun activePublicKeySpkiBase64Url(): String {
        val alias = committedAlias() ?: error("Device public key missing")
        return Base64Url.encode(requirePublicKey(alias).encoded)
    }

    /**
     * Create a pending keypair for a pairing attempt. Leaves the active
     * key untouched. Returns the pending public key as unpadded base64url SPKI.
     */
    @Synchronized
    override fun createPendingKeypair(): String {
        discardPendingKeyLocked()
        val active = committedAlias()
        val next = when (active) {
            ALIAS_A -> ALIAS_B
            ALIAS_B -> ALIAS_A
            else -> ALIAS_A
        }
        if (!tryGenerate(next, strongBox = true) && !tryGenerate(next, strongBox = false)) {
            error("Failed to generate pending ES256 device key in Android Keystore")
        }
        pendingAlias.set(next)
        return Base64Url.encode(requirePublicKey(next).encoded)
    }

    /** Promote the pending key to active and delete the previous active key. */
    @Synchronized
    override fun commitPendingKey() {
        val pending = pendingAlias.get() ?: error("No pending key to commit")
        val previous = committedAlias()
        activeAlias.set(pending)
        pendingAlias.set(null)
        if (previous != null && previous != pending) {
            deleteAlias(previous)
        }
        // Drop pre-STH-44 single alias if it somehow remained.
        if (pending != LEGACY_ALIAS) {
            deleteAlias(LEGACY_ALIAS)
        }
    }

    /** Drop a failed pairing attempt's pending key; leave active key alone. */
    @Synchronized
    override fun discardPendingKey() {
        discardPendingKeyLocked()
    }

    override fun deleteKey() {
        synchronized(this) {
            discardPendingKeyLocked()
            deleteAlias(ALIAS_A)
            deleteAlias(ALIAS_B)
            deleteAlias(LEGACY_ALIAS)
            activeAlias.set(null)
        }
    }

    private fun discardPendingKeyLocked() {
        val pending = pendingAlias.getAndSet(null) ?: return
        val active = committedAlias()
        if (pending != active) {
            deleteAlias(pending)
        }
    }

    /**
     * Committed (non-pending) alias present in Keystore. Rediscovers after
     * process death; prefers the cached [activeAlias] when still valid.
     */
    private fun committedAlias(): String? {
        val pending = pendingAlias.get()
        val cached = activeAlias.get()
        if (cached != null && cached != pending && contains(cached)) {
            return cached
        }
        val found = ALL_ALIASES.firstOrNull { it != pending && contains(it) } ?: return null
        activeAlias.set(found)
        return found
    }

    private fun contains(alias: String): Boolean = androidKeyStore().containsAlias(alias)

    private fun deleteAlias(alias: String) {
        val ks = androidKeyStore()
        if (ks.containsAlias(alias)) {
            ks.deleteEntry(alias)
        }
    }

    private fun tryGenerate(alias: String, strongBox: Boolean): Boolean {
        return try {
            deleteAlias(alias)
            val generator = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC,
                ANDROID_KEYSTORE,
            )
            val builder = KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_SIGN,
            )
                .setAlgorithmParameterSpec(java.security.spec.ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
            if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                builder.setIsStrongBoxBacked(true)
            }
            generator.initialize(builder.build())
            generator.generateKeyPair()
            true
        } catch (_: Exception) {
            false
        }
    }

    private fun requirePublicKey(alias: String): PublicKey {
        val cert: Certificate = androidKeyStore().getCertificate(alias)
            ?: error("Device public key certificate missing for alias=$alias")
        return cert.publicKey
    }

    private fun androidKeyStore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    companion object {
        const val ALIAS_A = "sms_gateway_device_es256_a"
        const val ALIAS_B = "sms_gateway_device_es256_b"
        /** Pre-transactional single alias from earlier STH-11 builds. */
        const val LEGACY_ALIAS = "sms_gateway_device_es256"
        /** @deprecated Prefer [ALIAS_A] / [committedAlias] rediscovery. */
        const val ALIAS = ALIAS_A
        private val ALL_ALIASES = listOf(ALIAS_A, ALIAS_B, LEGACY_ALIAS)
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    }
}
