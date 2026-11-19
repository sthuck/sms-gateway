package com.sthuck.smsgateway.crypto

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class Base64UrlTest {

    @Test
    fun roundTripsVariousLengthsWithoutPadding() {
        val inputs = listOf(
            "a",
            "ab",
            "abc",
            "abcd",
            """{"CF-Access-Client-Id":"id","CF-Access-Client-Secret":"secret"}""",
        )
        for (raw in inputs) {
            val bytes = raw.toByteArray(Charsets.UTF_8)
            val encoded = Base64Url.encode(bytes)
            assertEquals(-1, encoded.indexOf('='))
            assertArrayEquals(bytes, Base64Url.decode(encoded))
        }
    }

    @Test
    fun rejectsPaddingWhitespaceInvalidCharsAndInvalidLengths() {
        assertThrows(IllegalArgumentException::class.java) { Base64Url.decode("") }
        assertThrows(IllegalArgumentException::class.java) { Base64Url.decode("YQ==") }
        assertThrows(IllegalArgumentException::class.java) { Base64Url.decode("YWI=") }
        assertThrows(IllegalArgumentException::class.java) { Base64Url.decode("ab cd") }
        assertThrows(IllegalArgumentException::class.java) { Base64Url.decode("abcd\n") }
        assertThrows(IllegalArgumentException::class.java) { Base64Url.decode("ab+c") }
        assertThrows(IllegalArgumentException::class.java) { Base64Url.decode("ab/c") }
        // len % 4 == 1 is never valid unpadded base64url
        assertThrows(IllegalArgumentException::class.java) { Base64Url.decode("a") }
        assertThrows(IllegalArgumentException::class.java) { Base64Url.decode("abcde") }
    }
}
