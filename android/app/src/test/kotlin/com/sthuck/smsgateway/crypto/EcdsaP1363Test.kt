package com.sthuck.smsgateway.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.math.BigInteger

class EcdsaP1363Test {

    @Test
    fun roundTripShortCoordinates() {
        // r and s smaller than 32 bytes (leading zeros when fixed-width).
        val r = BigInteger("01", 16).toByteArray()
        val s = BigInteger("ff", 16).toByteArray()
        val der = encodeDer(r, s)
        val p1363 = EcdsaP1363.derToP1363(der)
        assertEquals(64, p1363.size)
        assertEquals(0, p1363[0].toInt())
        assertEquals(1, p1363[31].toInt())
        assertEquals(0xff.toByte(), p1363[63])

        val back = EcdsaP1363.p1363ToDer(p1363)
        val again = EcdsaP1363.derToP1363(back)
        assertArrayEquals(p1363, again)
    }

    @Test
    fun highBitCoordinatesGetIntegerPad() {
        val r = ByteArray(32) { if (it == 0) 0x80.toByte() else 0 }
        val s = ByteArray(32) { if (it == 0) 0xff.toByte() else 0x01 }
        val p1363 = r + s
        val der = EcdsaP1363.p1363ToDer(p1363)
        assertTrue(der[0] == 0x30.toByte())
        val roundTrip = EcdsaP1363.derToP1363(der)
        assertArrayEquals(p1363, roundTrip)
    }

    private fun encodeDer(r: ByteArray, s: ByteArray): ByteArray {
        fun intBytes(v: ByteArray): ByteArray {
            var start = 0
            while (start < v.lastIndex && v[start] == 0.toByte()) start++
            val stripped = if (start == 0) v else v.copyOfRange(start, v.size)
            val content = if ((stripped[0].toInt() and 0x80) != 0) byteArrayOf(0) + stripped else stripped
            return byteArrayOf(0x02, content.size.toByte()) + content
        }
        val body = intBytes(r) + intBytes(s)
        return byteArrayOf(0x30, body.size.toByte()) + body
    }
}
