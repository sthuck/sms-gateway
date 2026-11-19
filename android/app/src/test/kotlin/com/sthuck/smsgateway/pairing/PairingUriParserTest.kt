package com.sthuck.smsgateway.pairing

import com.sthuck.smsgateway.crypto.Base64Url
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingUriParserTest {

    @Test
    fun parsesShortCodeWithOptionalHyphen() {
        assertEquals("7K3M-9Q2P", PairingUriParser.parse("7k3m9q2p")!!.code)
        assertEquals("7K3M-9Q2P", PairingUriParser.parse("7K3M-9Q2P")!!.code)
    }

    @Test
    fun parsesDeepLinkWithServer() {
        val parsed = PairingUriParser.parse(
            "smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fapi.sms-gateway.example",
        )
        assertEquals("7K3M-9Q2P", parsed!!.code)
        assertEquals("https://api.sms-gateway.example", parsed.serverUrl)
    }

    @Test
    fun rejectsWrongHostOrPath() {
        assertNull(PairingUriParser.parse("smsgw://evil/pair?code=7K3M-9Q2P"))
        assertNull(PairingUriParser.parse("smsgw://pair/extra?code=7K3M-9Q2P"))
        assertNull(PairingUriParser.parse("https://example.com/pair?code=7K3M-9Q2P"))
    }

    @Test
    fun rejectsAmbiguousAlphabetLetters() {
        // I/L/O/U are mapped or rejected; U has no crockford mapping → reject.
        assertNull(PairingUriParser.normalizeCode("7K3U-9Q2P"))
    }

    @Test
    fun parsesValidHeadersParam() {
        val headersJson = """{"CF-Access-Client-Id":"id-1","CF-Access-Client-Secret":"sec-2"}"""
        val encoded = Base64Url.encode(headersJson.toByteArray(Charsets.UTF_8))
        val result = PairingUriParser.parseDetailed(
            "smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fsms.sthuck.info&headers=$encoded",
        )
        assertTrue(result is PairingUriParser.ParseResult.Ok)
        val uri = (result as PairingUriParser.ParseResult.Ok).value
        assertEquals("7K3M-9Q2P", uri.code)
        assertEquals("https://sms.sthuck.info", uri.serverUrl)
        assertEquals(
            mapOf("CF-Access-Client-Id" to "id-1", "CF-Access-Client-Secret" to "sec-2"),
            uri.accessHeaders,
        )
    }

    @Test
    fun omittedHeadersYieldsEmptyMap() {
        val uri = PairingUriParser.parse(
            "smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fsms.sthuck.info",
        )!!
        assertEquals(emptyMap<String, String>(), uri.accessHeaders)
    }

    @Test
    fun rejectsEmptyMalformedOrReservedHeadersParamInsteadOfDropping() {
        val reservedEncoded = Base64Url.encode("""{"Authorization":"Bearer x"}""".toByteArray())
        val emptyObjEncoded = Base64Url.encode("{}".toByteArray())
        val badUris = listOf(
            "smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fsms.sthuck.info&headers=",
            "smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fsms.sthuck.info&headers=not!b64",
            "smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fsms.sthuck.info&headers=e30=",
            "smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fsms.sthuck.info&headers=$emptyObjEncoded",
            "smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fsms.sthuck.info&headers=$reservedEncoded",
        )
        for (bad in badUris) {
            assertNull("expected null for $bad", PairingUriParser.parse(bad))
            assertTrue(
                "expected Err for $bad",
                PairingUriParser.parseDetailed(bad) is PairingUriParser.ParseResult.Err,
            )
        }
    }
}
