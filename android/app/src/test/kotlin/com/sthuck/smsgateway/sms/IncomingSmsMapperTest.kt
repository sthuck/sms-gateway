package com.sthuck.smsgateway.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IncomingSmsMapperTest {

    private val second = 1_794_995_112_000L // 2026-11-18T09:45:12Z

    @Test
    fun reassemblesMultipartByOriginatingAddressUsingFirstPartTimestamp() {
        val parts = listOf(
            SmsPduPart("+15551234567", "Your code is ", second),
            SmsPduPart("+15551234567", "123456", second + 10),
        )
        val result = IncomingSmsMapper.reassemble(parts, simSlot = 0)
        assertEquals(1, result.size)
        assertEquals("+15551234567", result[0].sender)
        assertEquals("Your code is 123456", result[0].body)
        assertEquals("2026-11-18T09:45:12Z", result[0].receivedAt)
        assertEquals(1_794_995_112L, result[0].timestampSeconds)
        assertEquals(0, result[0].simSlot)
        assertEquals(IncomingSmsMapper.DIRECTION_INBOUND, result[0].direction)
    }

    @Test
    fun splitsPartsWithDifferentSendersIntoSeparateMessages() {
        val parts = listOf(
            SmsPduPart("+15550000001", "one", second),
            SmsPduPart("+15550000002", "two", second + 1_000),
        )
        val result = IncomingSmsMapper.reassemble(parts, simSlot = null)
        assertEquals(2, result.size)
        assertEquals("+15550000001", result[0].sender)
        assertEquals("one", result[0].body)
        assertEquals("+15550000002", result[1].sender)
        assertEquals("two", result[1].body)
    }

    @Test
    fun skipsPartsWithNullOrBlankSender() {
        val parts = listOf(
            SmsPduPart(null, "ignored", second),
            SmsPduPart("", "also ignored", second),
            SmsPduPart("+15551234567", "kept", second),
        )
        val result = IncomingSmsMapper.reassemble(parts, simSlot = null)
        assertEquals(1, result.size)
        assertEquals("kept", result[0].body)
    }

    @Test
    fun deviceMsgIdIsDeterministicAndStable() {
        val first = IncomingSmsMapper.deviceMsgId(
            direction = "inbound",
            sender = "+15551234567",
            timestampSeconds = 1_794_995_112L,
            body = "Your code is 123456",
            ordinal = 0,
        )
        val second = IncomingSmsMapper.deviceMsgId(
            direction = "inbound",
            sender = "+15551234567",
            timestampSeconds = 1_794_995_112L,
            body = "Your code is 123456",
            ordinal = 0,
        )
        assertEquals(first, second)
        assertTrue(first.startsWith("sms-"))
        assertTrue(first.endsWith("-0"))
        assertTrue(first.length <= 128)
        val hex = first.removePrefix("sms-").substringBeforeLast("-")
        assertEquals(32, hex.length)
        assertTrue(hex.all { it in '0'..'9' || it in 'a'..'f' })
    }

    @Test
    fun deviceMsgIdDiffersWhenAnyHashedFieldDiffers() {
        val base = id("+15551234567", 1_794_995_112L, "hello", 0)
        assertNotEquals(base, id("+15559876543", 1_794_995_112L, "hello", 0))
        assertNotEquals(base, id("+15551234567", 1_794_995_113L, "hello", 0))
        assertNotEquals(base, id("+15551234567", 1_794_995_112L, "hello!", 0))
        assertNotEquals(
            base,
            IncomingSmsMapper.deviceMsgId("outbound", "+15551234567", 1_794_995_112L, "hello", 0),
        )
    }

    @Test
    fun sameContentInTheSameSecondSharesAContentKeyAndOrdinalDisambiguates() {
        val keyA = IncomingSmsMapper.contentKey("inbound", "+1555", 1_794_995_112L, "same")
        val keyB = IncomingSmsMapper.contentKey("inbound", "+1555", 1_794_995_112L, "same")
        assertEquals(keyA, keyB)
        // Milliseconds are not part of the key: both 12.000Z and 12.400Z hash as second 1794995112.
        val keySameSecond = IncomingSmsMapper.contentKey(
            "inbound",
            "+1555",
            IncomingSmsMapper.timestampSeconds(second + 400),
            "same",
        )
        assertEquals(keyA, keySameSecond)
        val first = IncomingSmsMapper.deviceMsgId(keyA, 0)
        val duplicate = IncomingSmsMapper.deviceMsgId(keyA, 1)
        assertNotEquals(first, duplicate)
        assertEquals("sms-$keyA-0", first)
        assertEquals("sms-$keyA-1", duplicate)
    }

    @Test
    fun mapsSimSlotIncludingUnknown() {
        assertEquals(0, IncomingSmsMapper.mapSimSlot(0))
        assertEquals(1, IncomingSmsMapper.mapSimSlot(1))
        assertEquals(9, IncomingSmsMapper.mapSimSlot(9))
        assertNull(IncomingSmsMapper.mapSimSlot(null))
        assertNull(IncomingSmsMapper.mapSimSlot(-1))
        assertNull(IncomingSmsMapper.mapSimSlot(10))
        assertNull(IncomingSmsMapper.mapSimSlot(SubscriptionLike.INVALID_SLOT))
        val withSlot = IncomingSmsMapper.reassemble(
            listOf(SmsPduPart("+1555", "x", second)),
            simSlot = 1,
        )
        assertEquals(1, withSlot.single().simSlot)
        val unknown = IncomingSmsMapper.reassemble(
            listOf(SmsPduPart("+1555", "x", second)),
            simSlot = -1,
        )
        assertNull(unknown.single().simSlot)
        val over = IncomingSmsMapper.reassemble(
            listOf(SmsPduPart("+1555", "x", second)),
            simSlot = 10,
        )
        assertNull(over.single().simSlot)
    }

    @Test
    fun clipsSenderTo64CodePoints() {
        val longSender = "A".repeat(80)
        val clipped = IncomingSmsMapper.clipSender(longSender)
        assertEquals(64, IncomingSmsMapper.unicodeLength(clipped))
        val assembled = IncomingSmsMapper.reassemble(
            listOf(SmsPduPart(longSender, "hi", second)),
            simSlot = null,
        ).single()
        assertEquals(64, IncomingSmsMapper.unicodeLength(assembled.sender))
    }

    @Test
    fun unicodeLengthCountsCodePointsNotCharUnits() {
        val emoji = "😀" // one code point, two UTF-16 chars
        assertEquals(2, emoji.length)
        assertEquals(1, IncomingSmsMapper.unicodeLength(emoji))
        assertEquals("😀😀", IncomingSmsMapper.takeCodePoints(emoji.repeat(5), 2))
    }

    @Test
    fun formatsReceivedAtAsIso8601UtcWithZ() {
        assertEquals("2026-11-18T09:45:12Z", IncomingSmsMapper.formatReceivedAt(second))
        assertEquals("2026-11-18T09:45:12.123Z", IncomingSmsMapper.formatReceivedAt(second + 123))
        assertTrue(IncomingSmsMapper.formatReceivedAt(second).endsWith("Z"))
        assertTrue(IncomingSmsMapper.formatReceivedAt(second + 123).endsWith("Z"))
    }

    @Test
    fun allowsEmptyBody() {
        val result = IncomingSmsMapper.reassemble(
            listOf(SmsPduPart("+15551234567", "", second)),
            simSlot = null,
        )
        assertEquals("", result.single().body)
        val id = IncomingSmsMapper.deviceMsgId("inbound", "+15551234567", 1_794_995_112L, "", 0)
        assertTrue(id.startsWith("sms-"))
    }

    @Test
    fun keepsAlphanumericSenderAndLeadingPlus() {
        val alpha = IncomingSmsMapper.reassemble(
            listOf(SmsPduPart("ACME", "Promo", second)),
            simSlot = null,
        ).single()
        assertEquals("ACME", alpha.sender)
        val e164 = IncomingSmsMapper.reassemble(
            listOf(SmsPduPart("+15551234567", "Hi", second)),
            simSlot = null,
        ).single()
        assertEquals("+15551234567", e164.sender)
        assertTrue(e164.sender.startsWith("+"))
    }

    @Test
    fun contentKeyDoesNotCollideWhenNewlinesShiftFields() {
        val a = IncomingSmsMapper.contentKey("inbound", "a", 1L, "1\n2")
        val b = IncomingSmsMapper.contentKey("inbound", "a\n1\n2", 1L, "")
        val c = IncomingSmsMapper.contentKey("inbound", "a\n1", 1L, "2")
        assertNotEquals(a, b)
        assertNotEquals(a, c)
        assertNotEquals(b, c)
    }

    private fun id(sender: String, seconds: Long, body: String, ordinal: Int): String =
        IncomingSmsMapper.deviceMsgId("inbound", sender, seconds, body, ordinal)

    private object SubscriptionLike {
        const val INVALID_SLOT = -1
    }
}
