package com.sthuck.smsgateway.crypto

import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature

/** Signs the UTF-8 canonical string with ES256 (IEEE P1363). */
fun interface DeviceSigner {
    fun sign(canonicalUtf8: ByteArray): ByteArray
}

/**
 * Signs with portable `SHA256withECDSA` (DER) and converts to P1363 so the
 * same code path works from minSdk 26 through modern devices.
 */
class PrivateKeyDeviceSigner(
    private val privateKey: PrivateKey,
) : DeviceSigner {
    override fun sign(canonicalUtf8: ByteArray): ByteArray {
        val signature = Signature.getInstance(ES256_DER)
        signature.initSign(privateKey)
        signature.update(canonicalUtf8)
        return EcdsaP1363.derToP1363(signature.sign())
    }

    companion object {
        const val ES256_DER = "SHA256withECDSA"
        /** Legacy name (API 34+); prefer [ES256_DER] + [EcdsaP1363]. */
        const val ES256_P1363 = "SHA256withECDSAinP1363Format"
    }
}

fun verifyEs256P1363(
    publicKey: PublicKey,
    canonicalUtf8: ByteArray,
    signatureP1363: ByteArray,
): Boolean {
    return try {
        val der = EcdsaP1363.p1363ToDer(signatureP1363)
        val signature = Signature.getInstance(PrivateKeyDeviceSigner.ES256_DER)
        signature.initVerify(publicKey)
        signature.update(canonicalUtf8)
        signature.verify(der)
    } catch (_: Exception) {
        false
    }
}
