package com.sthuck.smsgateway.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PairingUriParserTest {

    @Test
    fun parsesShortCode() {
        val parsed = PairingUriParser.parse("7k3m-9q2p")
        assertEquals("7K3M-9Q2P", parsed!!.code)
        assertNull(parsed.serverUrl)
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
    fun rejectsGarbage() {
        assertNull(PairingUriParser.parse(""))
        assertNull(PairingUriParser.parse("not-a-code"))
        assertNull(PairingUriParser.parse("https://example.com/pair?code=7K3M-9Q2P"))
    }
}
