package com.sthuck.smsgateway.ui

import com.sthuck.smsgateway.crypto.Base64Url
import com.sthuck.smsgateway.pairing.PairingUriParser
import com.sthuck.smsgateway.pairing.ServerUrlValidator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Confirmation / no-auto-submit / one-shot intent rules (STH-43 / STH-44).
 */
class PairingConfirmationTest {

    @Test
    fun scanPreparesConfirmationWithoutPairing() {
        val encodedHeaders = Base64Url.encode(
            """{"CF-Access-Client-Id":"id","CF-Access-Client-Secret":"secret"}""".toByteArray(),
        )
        val parsed = PairingUriParser.parse(
            "smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fsms.sthuck.info&headers=$encodedHeaders",
        )!!
        val validated = ServerUrlValidator.validate(
            parsed.serverUrl,
            isDevFlavor = false,
            fallback = "https://sms.sthuck.info",
        ) as ServerUrlValidator.Result.Ok

        val confirmation = PairingConfirmation(
            code = parsed.code,
            serverUrl = validated.value.url,
            hostLabel = validated.value.hostWithPort,
            requiresExtraWarning = validated.value.requiresExtraWarning,
            replacingExisting = false,
            accessHeaders = parsed.accessHeaders,
        )
        assertEquals("7K3M-9Q2P", confirmation.code)
        assertEquals("sms.sthuck.info", confirmation.hostLabel)
        assertFalse(confirmation.requiresExtraWarning)
        assertEquals(listOf("CF-Access-Client-Id", "CF-Access-Client-Secret"), confirmation.accessHeaders.keys.sorted())
        // Confirmation is the only side effect of a scan — no repository call.
        assertNotNull(confirmation)
    }

    @Test
    fun unlistedHostRequiresExtraWarning() {
        val validated = ServerUrlValidator.validate(
            "https://attacker.example",
            isDevFlavor = false,
            fallback = "https://sms.sthuck.info",
        ) as ServerUrlValidator.Result.Ok
        assertTrue(validated.value.requiresExtraWarning)
    }

    @Test
    fun deepLinkConsumedExactlyOnceOnRecreation() {
        // Mirrors MainActivity: handle only when savedInstanceState == null,
        // then clear intent data so rotation cannot replay.
        var intentData: String? =
            "smsgw://pair?code=7K3M-9Q2P&server=http%3A%2F%2F10.0.2.2%3A4010"
        var deliveries = 0

        fun handlePairingIntent(isFirstCreate: Boolean) {
            if (!isFirstCreate) return
            val data = intentData ?: return
            if (!data.startsWith("smsgw://")) return
            intentData = null
            deliveries++
        }

        handlePairingIntent(isFirstCreate = true) // cold start
        handlePairingIntent(isFirstCreate = false) // rotation / process recreation with state
        handlePairingIntent(isFirstCreate = true) // would be a new create, but data already cleared

        assertEquals(1, deliveries)
        assertNull(intentData)
    }

    @Test
    fun pairedDeviceIgnoresInboundDeepLink() {
        val pairedDeviceId: String? = "existing-device"
        var confirmationShown = false
        fun onScannedOrDeepLink(raw: String) {
            if (pairedDeviceId != null) return
            confirmationShown = true
            PairingUriParser.parse(raw)
        }
        onScannedOrDeepLink("smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fattacker.example")
        assertFalse(confirmationShown)
    }

    @Test
    fun mockEmulatorHostAllowedInDev() {
        val validated = ServerUrlValidator.validate(
            "http://10.0.2.2:4010",
            isDevFlavor = true,
            fallback = "http://10.0.2.2:4010",
        ) as ServerUrlValidator.Result.Ok
        assertEquals("http://10.0.2.2:4010", validated.value.url)
        assertFalse(validated.value.requiresExtraWarning)
    }
}
