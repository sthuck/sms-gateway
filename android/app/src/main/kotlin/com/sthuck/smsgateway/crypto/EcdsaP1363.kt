package com.sthuck.smsgateway.crypto

/**
 * Convert between ASN.1 DER ECDSA signatures (`SHA256withECDSA`) and IEEE
 * P1363 raw `r || s` (fixed-width, big-endian, left-zero-padded).
 *
 * Used so signing works on API 26–33 where `SHA256withECDSAinP1363Format`
 * may be unavailable, while the wire format stays P1363 per the contract.
 */
object EcdsaP1363 {
    const val P256_COORD_BYTES = 32

    fun derToP1363(der: ByteArray, coordBytes: Int = P256_COORD_BYTES): ByteArray {
        // SEQUENCE { INTEGER r, INTEGER s }
        var i = 0
        require(der[i++] == 0x30.toByte()) { "not a DER SEQUENCE" }
        val seqLen = readLength(der, i).also { i = it.second }.first
        require(i + seqLen == der.size) { "DER length mismatch" }

        require(der[i++] == 0x02.toByte()) { "expected INTEGER r" }
        val rLen = readLength(der, i).also { i = it.second }.first
        val r = der.copyOfRange(i, i + rLen)
        i += rLen

        require(der[i++] == 0x02.toByte()) { "expected INTEGER s" }
        val sLen = readLength(der, i).also { i = it.second }.first
        val s = der.copyOfRange(i, i + sLen)

        val out = ByteArray(coordBytes * 2)
        writeUnsignedFixed(r, out, 0, coordBytes)
        writeUnsignedFixed(s, out, coordBytes, coordBytes)
        return out
    }

    fun p1363ToDer(p1363: ByteArray, coordBytes: Int = P256_COORD_BYTES): ByteArray {
        require(p1363.size == coordBytes * 2) { "P1363 length must be ${coordBytes * 2}" }
        val r = stripLeadingZeros(p1363.copyOfRange(0, coordBytes))
        val s = stripLeadingZeros(p1363.copyOfRange(coordBytes, coordBytes * 2))
        val rInt = encodeInteger(r)
        val sInt = encodeInteger(s)
        val body = rInt + sInt
        return byteArrayOf(0x30) + encodeLength(body.size) + body
    }

    private fun writeUnsignedFixed(value: ByteArray, dest: ByteArray, offset: Int, size: Int) {
        val trimmed = stripLeadingZeros(value)
        require(trimmed.size <= size) { "coordinate too large for $size bytes" }
        // left-pad with zeros
        System.arraycopy(trimmed, 0, dest, offset + (size - trimmed.size), trimmed.size)
    }

    private fun stripLeadingZeros(value: ByteArray): ByteArray {
        var start = 0
        while (start < value.lastIndex && value[start] == 0.toByte()) start++
        return value.copyOfRange(start, value.size)
    }

    private fun encodeInteger(unsigned: ByteArray): ByteArray {
        val needsPad = unsigned.isNotEmpty() && (unsigned[0].toInt() and 0x80) != 0
        val content = if (needsPad) byteArrayOf(0) + unsigned else unsigned
        return byteArrayOf(0x02) + encodeLength(content.size) + content
    }

    private fun encodeLength(length: Int): ByteArray = when {
        length < 0x80 -> byteArrayOf(length.toByte())
        length <= 0xff -> byteArrayOf(0x81.toByte(), length.toByte())
        else -> byteArrayOf(0x82.toByte(), (length shr 8).toByte(), length.toByte())
    }

    private fun readLength(data: ByteArray, index: Int): Pair<Int, Int> {
        var i = index
        val first = data[i++].toInt() and 0xff
        if (first and 0x80 == 0) return first to i
        val num = first and 0x7f
        require(num in 1..2) { "unsupported DER length" }
        var len = 0
        repeat(num) { len = (len shl 8) or (data[i++].toInt() and 0xff) }
        return len to i
    }
}
