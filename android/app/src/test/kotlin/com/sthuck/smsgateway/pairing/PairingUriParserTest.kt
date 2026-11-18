package com.sthuck.smsgateway.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
}
