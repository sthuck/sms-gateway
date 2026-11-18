package com.sthuck.smsgateway.crypto

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.cert.Certificate
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Non-exportable ES256 (P-256) keypair in Android Keystore.
 * Tries StrongBox first, falls back to TEE/software-backed Keystore.
 */
@Singleton
class DeviceKeyStore @Inject constructor() {

    fun hasKey(): Boolean = androidKeyStore().containsAlias(ALIAS)

    fun getOrCreatePublicKeySpkiBase64Url(): String {
        ensureKey()
        return Base64Url.encode(requirePublicKey().encoded)
    }

    fun signer(): DeviceSigner {
        ensureKey()
        val privateKey = androidKeyStore().getKey(ALIAS, null) as? PrivateKey
            ?: error("Device signing key missing after ensureKey()")
        return PrivateKeyDeviceSigner(privateKey)
    }

    fun publicKey(): PublicKey {
        ensureKey()
        return requirePublicKey()
    }

    fun deleteKey() {
        val ks = androidKeyStore()
        if (ks.containsAlias(ALIAS)) {
            ks.deleteEntry(ALIAS)
        }
    }

    private fun ensureKey() {
        if (hasKey()) return
        if (!tryGenerate(strongBox = true)) {
            check(tryGenerate(strongBox = false)) {
                "Failed to generate ES256 device key in Android Keystore"
            }
        }
    }

    private fun tryGenerate(strongBox: Boolean): Boolean {
        return try {
            val generator = KeyPairGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_EC,
                ANDROID_KEYSTORE,
            )
            val builder = KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
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

    private fun requirePublicKey(): PublicKey {
        val cert: Certificate = androidKeyStore().getCertificate(ALIAS)
            ?: error("Device public key certificate missing")
        return cert.publicKey
    }

    private fun androidKeyStore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    companion object {
        const val ALIAS = "sms_gateway_device_es256"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    }
}
