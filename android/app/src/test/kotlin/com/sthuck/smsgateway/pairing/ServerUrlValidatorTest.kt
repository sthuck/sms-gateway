package com.sthuck.smsgateway.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerUrlValidatorTest {

    @Test
    fun prodRejectsHttp() {
        val result = ServerUrlValidator.validate(
            "http://evil.example",
            isDevFlavor = false,
            fallback = "https://sms.sthuck.info",
        )
        assertTrue(result is ServerUrlValidator.Result.Err)
    }

    @Test
    fun prodAllowlistedHttpsOk() {
        val result = ServerUrlValidator.validate(
            "https://sms.sthuck.info/",
            isDevFlavor = false,
            fallback = "https://sms.sthuck.info",
        ) as ServerUrlValidator.Result.Ok
        assertEquals("https://sms.sthuck.info", result.value.url)
        assertFalse(result.value.requiresExtraWarning)
    }

    @Test
    fun prodUnlistedHttpsNeedsWarning() {
        val result = ServerUrlValidator.validate(
            "https://evil.example",
            isDevFlavor = false,
            fallback = "https://sms.sthuck.info",
        ) as ServerUrlValidator.Result.Ok
        assertTrue(result.value.requiresExtraWarning)
        assertEquals("evil.example", result.value.hostWithPort)
    }

    @Test
    fun prodRejectsUserinfoAndPath() {
        assertTrue(
            ServerUrlValidator.validate(
                "https://user:pass@sms.sthuck.info",
                isDevFlavor = false,
            ) is ServerUrlValidator.Result.Err,
        )
        assertTrue(
            ServerUrlValidator.validate(
                "https://sms.sthuck.info/v1",
                isDevFlavor = false,
            ) is ServerUrlValidator.Result.Err,
        )
    }

    @Test
    fun devAllowsEmulatorCleartext() {
        val result = ServerUrlValidator.validate(
            "http://10.0.2.2:4010",
            isDevFlavor = true,
            fallback = "http://10.0.2.2:4010",
        ) as ServerUrlValidator.Result.Ok
        assertEquals("http://10.0.2.2:4010", result.value.url)
        assertEquals("10.0.2.2:4010", result.value.hostWithPort)
    }

    @Test
    fun devRejectsOtherCleartextHosts() {
        assertTrue(
            ServerUrlValidator.validate(
                "http://evil.example",
                isDevFlavor = true,
            ) is ServerUrlValidator.Result.Err,
        )
    }

    @Test
    fun rejectsGarbage() {
        assertTrue(
            ServerUrlValidator.validate(
                "javascript:alert(1)",
                isDevFlavor = false,
            ) is ServerUrlValidator.Result.Err,
        )
    }
}
