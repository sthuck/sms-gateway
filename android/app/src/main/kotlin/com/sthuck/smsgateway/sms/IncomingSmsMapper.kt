package com.sthuck.smsgateway.sms

import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.time.Instant
import java.time.format.DateTimeFormatter

/**
 * Pure mapping from received SMS PDUs to the STH-5 device-message shape.
 *
 * ## device_msg_id
 *
 * Format: `sms-{contentKey}-{ordinal}` (always ≤ 128 characters).
 *
 * `contentKey` is the first 32 lowercase hex characters of SHA-256 over a
 * length-prefixed canonical encoding of
 * `(direction, sender, SMSC timestamp in seconds, body)`:
 *
 * 1. Each string field is encoded as UTF-8.
 * 2. The preimage is, for each field in order (`direction`, `sender`,
 *    decimal ASCII `timestampSeconds`, `body`): a 4-byte big-endian length
 *    followed by the field bytes.
 * 3. Length-prefixing is deliberate: a newline (or any other character)
 *    inside `sender` or `body` must not be able to collide with a different
 *    field split.
 *
 * `ordinal` is a 0-based index among messages that share the same
 * `contentKey`. It disambiguates genuine identical SMS (same sender, body,
 * and SMSC second) without using the Telephony provider `_id`, which is not
 * available on the `SMS_RECEIVED` broadcast.
 *
 * **Live receiver:** `ordinal` is the number of rows already in the local
 * queue with that `contentKey` at insert time (0 for the first).
 *
 * **Backfill (later ticket):** group inbox rows by the same content key
 * (`direction = inbound`, `address` as stored, `date_sent / 1000`, `body`),
 * sort each group by provider `_id` ascending, and assign ordinal 0, 1, 2…
 * That matches the live path when inbox `_id` order follows receive order,
 * which is the usual case. Do not also count inbox rows at live-receive
 * time: `SMS_RECEIVED` fires before the default SMS app writes the inbox,
 * so the current message is not there yet and a previous sibling might
 * already be in both the queue and the inbox.
 *
 * The same SMS seen first by the receiver and later by a backfill must
 * produce the same id. The id is independent of process restarts.
 */
object IncomingSmsMapper {
    const val DIRECTION_INBOUND = "inbound"
    const val ID_PREFIX = "sms-"
    const val CONTENT_KEY_HEX_CHARS = 32

    fun contentKey(
        direction: String,
        sender: String,
        timestampSeconds: Long,
        body: String,
    ): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(lengthPrefixed(direction))
        digest.update(lengthPrefixed(sender))
        digest.update(lengthPrefixed(timestampSeconds.toString()))
        digest.update(lengthPrefixed(body))
        return digest.digest().toHex().take(CONTENT_KEY_HEX_CHARS)
    }

    fun deviceMsgId(contentKey: String, ordinal: Int): String {
        require(ordinal >= 0) { "ordinal must be >= 0" }
        val id = "$ID_PREFIX$contentKey-$ordinal"
        require(id.length <= 128) { "device_msg_id exceeds 128 characters: $id" }
        return id
    }

    fun deviceMsgId(
        direction: String,
        sender: String,
        timestampSeconds: Long,
        body: String,
        ordinal: Int,
    ): String = deviceMsgId(contentKey(direction, sender, timestampSeconds, body), ordinal)

    /**
     * Contract `sim_slot`: zero-based slot index, or null if unknown / -1.
     */
    fun mapSimSlot(slotIndex: Int?): Int? =
        if (slotIndex == null || slotIndex < 0) null else slotIndex

    /**
     * SMSC timestamp as UTC ISO 8601 with a `Z` suffix. Fractional seconds
     * are included when the millisecond value is not a whole second.
     */
    fun formatReceivedAt(timestampMillis: Long): String =
        DateTimeFormatter.ISO_INSTANT.format(Instant.ofEpochMilli(timestampMillis))

    fun timestampSeconds(timestampMillis: Long): Long = timestampMillis.floorDiv(1000)

    /**
     * Reassemble PDUs from one `SMS_RECEIVED` broadcast.
     *
     * Parts that share an originating address are concatenated in the order
     * given (the order `getMessagesFromIntent` returns). The first part's
     * SMSC timestamp is used. Parts with a null or blank address are skipped.
     * The address is not normalised: a leading `+` is kept, alphanumeric
     * senders are kept as-is.
     */
    fun reassemble(parts: List<SmsPduPart>, simSlot: Int?): List<AssembledSms> {
        val slot = mapSimSlot(simSlot)
        val groups = LinkedHashMap<String, MutableList<SmsPduPart>>()
        for (part in parts) {
            val sender = part.originatingAddress ?: continue
            if (sender.isEmpty()) continue
            groups.getOrPut(sender) { mutableListOf() }.add(part)
        }
        return groups.map { (sender, group) ->
            val first = group.first()
            val body = group.joinToString(separator = "") { it.body }
            val seconds = timestampSeconds(first.timestampMillis)
            AssembledSms(
                sender = sender,
                body = body,
                receivedAt = formatReceivedAt(first.timestampMillis),
                timestampSeconds = seconds,
                simSlot = slot,
                contentKey = contentKey(DIRECTION_INBOUND, sender, seconds, body),
                direction = DIRECTION_INBOUND,
            )
        }
    }

    private fun lengthPrefixed(value: String): ByteArray {
        val bytes = value.toByteArray(Charsets.UTF_8)
        val out = ByteArrayOutputStream(4 + bytes.size)
        val length = bytes.size
        out.write((length ushr 24) and 0xFF)
        out.write((length ushr 16) and 0xFF)
        out.write((length ushr 8) and 0xFF)
        out.write(length and 0xFF)
        out.write(bytes)
        return out.toByteArray()
    }

    private fun ByteArray.toHex(): String {
        val chars = CharArray(size * 2)
        var i = 0
        for (b in this) {
            val v = b.toInt() and 0xFF
            chars[i++] = HEX[v ushr 4]
            chars[i++] = HEX[v and 0x0F]
        }
        return String(chars)
    }

    private val HEX = "0123456789abcdef".toCharArray()
}

/** One PDU from `Telephony.Sms.Intents.getMessagesFromIntent`. */
data class SmsPduPart(
    val originatingAddress: String?,
    val body: String,
    val timestampMillis: Long,
)

/** One contract-shaped inbound message, before a `device_msg_id` ordinal is assigned. */
data class AssembledSms(
    val sender: String,
    val body: String,
    val receivedAt: String,
    val timestampSeconds: Long,
    val simSlot: Int?,
    val contentKey: String,
    val direction: String = IncomingSmsMapper.DIRECTION_INBOUND,
)
