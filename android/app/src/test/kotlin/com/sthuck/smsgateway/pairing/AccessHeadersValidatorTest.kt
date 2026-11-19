package com.sthuck.smsgateway.pairing

import com.sthuck.smsgateway.crypto.Base64Url
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccessHeadersValidatorTest {

    @Test
    fun acceptsValidCloudflareAccessPair() {
        val raw = """{"CF-Access-Client-Id":"abc.access","CF-Access-Client-Secret":"super-secret-value"}"""
        val encoded = Base64Url.encode(raw.toByteArray(Charsets.UTF_8))
        val result = AccessHeadersValidator.decodeBase64UrlJson(encoded)
        assertTrue("expected Ok, got $result", result is AccessHeadersValidator.Result.Ok)
        val headers = (result as AccessHeadersValidator.Result.Ok).headers
        assertEquals("abc.access", headers["CF-Access-Client-Id"])
        assertEquals("super-secret-value", headers["CF-Access-Client-Secret"])
    }

    @Test
    fun rejectsEmptyStringPaddingAndNonJson() {
        assertTrue(AccessHeadersValidator.decodeBase64UrlJson("") is AccessHeadersValidator.Result.Err)
        assertTrue(AccessHeadersValidator.decodeBase64UrlJson("e30=") is AccessHeadersValidator.Result.Err)
        val nonJson = Base64Url.encode("not-json".toByteArray(Charsets.UTF_8))
        assertTrue(AccessHeadersValidator.decodeBase64UrlJson(nonJson) is AccessHeadersValidator.Result.Err)
    }

    @Test
    fun rejectsEmptyObjectArrayAndNonStringValues() {
        val samples = listOf(
            "{}",
            "[]",
            """["CF-Access-Client-Id"]""",
            """{"X-Custom":123}""",
            """{"X-Custom":true}""",
            """{"X-Custom":null}""",
            """{"X-Custom":{"nested":"v"}}""",
            """{"X-Custom":["a"]}""",
        )
        for (jsonText in samples) {
            val encoded = Base64Url.encode(jsonText.toByteArray(Charsets.UTF_8))
            val result = AccessHeadersValidator.decodeBase64UrlJson(encoded)
            assertTrue("expected Err for $jsonText", result is AccessHeadersValidator.Result.Err)
        }
    }

    @Test
    fun rejectsAllReservedHeadersCaseInsensitively() {
        val reserved = listOf(
            "Host",
            "authorization",
            "Proxy-Authorization",
            "COOKIE",
            "Origin",
            "Referer",
            "Content-Type",
            "Content-Length",
            "Content-Encoding",
            "Transfer-Encoding",
            "Connection",
            "X-CSRF-Token",
            "X-Device-Id",
            "x-timestamp",
            "X-Nonce",
            "X-Content-SHA256",
            "X-Signature",
        )
        assertEquals(17, reserved.size)
        for (name in reserved) {
            val result = AccessHeadersValidator.validate(mapOf(name to "val"))
            assertTrue("expected reserved header $name to fail", result is AccessHeadersValidator.Result.Err)
        }
    }

    @Test
    fun rejectsCaseInsensitiveDuplicates() {
        val raw = """{"X-Custom":"one","x-custom":"two"}"""
        val encoded = Base64Url.encode(raw.toByteArray(Charsets.UTF_8))
        assertTrue(AccessHeadersValidator.decodeBase64UrlJson(encoded) is AccessHeadersValidator.Result.Err)
    }

    @Test
    fun rejectsInvalidHeaderNames() {
        assertTrue(AccessHeadersValidator.validate(mapOf("" to "v")) is AccessHeadersValidator.Result.Err)
        assertTrue(
            AccessHeadersValidator.validate(mapOf("a".repeat(129) to "v")) is AccessHeadersValidator.Result.Err,
        )
        assertTrue(AccessHeadersValidator.validate(mapOf("Bad Header" to "v")) is AccessHeadersValidator.Result.Err)
        assertTrue(AccessHeadersValidator.validate(mapOf("Bad:Header" to "v")) is AccessHeadersValidator.Result.Err)
        assertTrue(AccessHeadersValidator.validate(mapOf("Bad\nHeader" to "v")) is AccessHeadersValidator.Result.Err)
    }

    @Test
    fun rejectsControlCharsCrLfNulAndSurroundingWhitespaceInValues() {
        val badValues = listOf(
            "",
            " leading",
            "trailing ",
            "both ",
            "line1\rline2",
            "line1\nline2",
            "has\u0000nul",
            "has\ttab",
            "has\u007Fdel",
            "non-ascii-é",
            "x".repeat(1025),
        )
        for (value in badValues) {
            val result = AccessHeadersValidator.validate(mapOf("X-Custom" to value))
            assertTrue("expected invalid value to fail: ${value.length}", result is AccessHeadersValidator.Result.Err)
            if (result is AccessHeadersValidator.Result.Err && value.length > 3) {
                assertFalse("error must not leak header value", result.message.contains(value))
            }
        }
    }

    @Test
    fun rejectsMoreThanEightHeaders() {
        val headers = (1..9).associate { "X-Header-$it" to "v$it" }
        assertTrue(AccessHeadersValidator.validate(headers) is AccessHeadersValidator.Result.Err)

        val exactlyEight = (1..8).associate { "X-Header-$it" to "v$it" }
        assertTrue(AccessHeadersValidator.validate(exactlyEight) is AccessHeadersValidator.Result.Ok)
    }

    @Test
    fun rejectsOversizedDecodedJsonOverTwoKib() {
        val headers = mapOf(
            "X-H1" to "a".repeat(1024),
            "X-H2" to "b".repeat(1024),
        )
        assertTrue(AccessHeadersValidator.validate(headers) is AccessHeadersValidator.Result.Err)

        val paddedJson = """{"X-H1":"val"${" ".repeat(2040)}}"""
        assertTrue(paddedJson.toByteArray(Charsets.UTF_8).size > 2048)
        val encoded = Base64Url.encode(paddedJson.toByteArray(Charsets.UTF_8))
        assertTrue(AccessHeadersValidator.decodeBase64UrlJson(encoded) is AccessHeadersValidator.Result.Err)
    }
}
