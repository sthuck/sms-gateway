package com.sthuck.smsgateway.crypto

import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature

/** Signs the UTF-8 canonical string with ES256 (IEEE P1363). */
fun interface DeviceSigner {
    fun sign(canonicalUtf8: ByteArray): ByteArray
}

class PrivateKeyDeviceSigner(
    private val privateKey: PrivateKey,
) : DeviceSigner {
    override fun sign(canonicalUtf8: ByteArray): ByteArray {
        val signature = Signature.getInstance(ES256_P1363)
        signature.initSign(privateKey)
        signature.update(canonicalUtf8)
        return signature.sign()
    }

    companion object {
        const val ES256_P1363 = "SHA256withECDSAinP1363Format"
    }
}

fun verifyEs256P1363(
    publicKey: PublicKey,
    canonicalUtf8: ByteArray,
    signatureP1363: ByteArray,
): Boolean {
    val signature = Signature.getInstance(PrivateKeyDeviceSigner.ES256_P1363)
    signature.initVerify(publicKey)
    signature.update(canonicalUtf8)
    return signature.verify(signatureP1363)
}
