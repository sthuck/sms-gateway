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
 * The active alias is persisted with pairing credentials and restored via
 * [restorePreferredActiveAlias] after process death (both A/B may briefly
 * exist until the previous alias is retired after [savePairing]).
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
    /**
     * Promote the pending key to active without deleting the previous alias.
     * Returns the new active alias; callers must persist it then call
     * [deleteKeyAlias] on the previous alias.
     */
    fun commitPendingKey(): String
    /** Current committed alias, or null when unpaired / only pending exists. */
    fun currentActiveAlias(): String?
    /** Prefer this alias after process death when both A/B survive. */
    fun restorePreferredActiveAlias(alias: String?)
    /** Delete a retired Keystore alias (no-op if missing or still active). */
    fun deleteKeyAlias(alias: String)
    fun discardPendingKey()
}

@Singleton
class DeviceKeyStore @Inject constructor() : DeviceKeyAccess {

    private val pendingAlias = AtomicReference<String?>(null)
    private val activeAlias = AtomicReference<String?>(null)
    private val preferredActiveAlias = AtomicReference<String?>(null)

    override fun hasKey(): Boolean = committedAlias() != null

    override fun hasPendingKey(): Boolean = pendingAlias.get()?.let { contains(it) } == true

    override fun currentActiveAlias(): String? = committedAlias()

    override fun restorePreferredActiveAlias(alias: String?) {
        preferredActiveAlias.set(alias?.takeIf { it.isNotBlank() })
        if (alias != null && contains(alias)) {
            activeAlias.set(alias)
        }
    }

    override fun deleteKeyAlias(alias: String) {
        synchronized(this) {
            if (alias == activeAlias.get() || alias == pendingAlias.get()) return
            deleteAlias(alias)
        }
    }

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

    /**
     * Promote the pending key to active. Keeps the previous alias in Keystore
     * until [deleteKeyAlias] so a crash before credential save cannot leave
     * the old device id pointing at a deleted key.
     */
    @Synchronized
    override fun commitPendingKey(): String {
        val pending = pendingAlias.get() ?: error("No pending key to commit")
        if (!contains(pending)) error("Pending device signing key missing")
        activeAlias.set(pending)
        preferredActiveAlias.set(pending)
        pendingAlias.set(null)
        return pending
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
            preferredActiveAlias.set(null)
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
     * process death; prefers persisted [preferredActiveAlias], then the
     * in-memory cache, then first surviving alias.
     */
    private fun committedAlias(): String? {
        val pending = pendingAlias.get()
        val preferred = preferredActiveAlias.get()
        if (preferred != null && preferred != pending && contains(preferred)) {
            activeAlias.set(preferred)
            return preferred
        }
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
