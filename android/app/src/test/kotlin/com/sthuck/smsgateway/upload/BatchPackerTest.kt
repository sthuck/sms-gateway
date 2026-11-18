package com.sthuck.smsgateway.upload

import com.sthuck.smsgateway.data.local.QueuedMessageEntity
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BatchPackerTest {

    private val json = Json {
        encodeDefaults = true
        explicitNulls = false
        namingStrategy = JsonNamingStrategy.SnakeCase
    }

    @Test
    fun respectsMaxMessageCount() {
        val rows = (0 until 150).map { i -> sampleRow("sms-$i", "body-$i") }
        val pack = BatchPacker.pack(rows, json, maxMessages = 100)
        assertEquals(100, pack.rows.size)
        assertTrue(pack.bodyBytes <= UploadDefaults.MAX_BATCH_BODY_BYTES)
    }

    @Test
    fun respectsMaxBodyBytes() {
        val huge = "x".repeat(20_000)
        val rows = (0 until 100).map { i -> sampleRow("sms-$i", huge) }
        val pack = BatchPacker.pack(rows, json, maxMessages = 100, maxBodyBytes = 50_000)
        assertTrue(pack.rows.isNotEmpty())
        assertTrue(pack.rows.size < 100)
        assertTrue(pack.bodyBytes <= 50_000)
    }

    @Test
    fun singleOversizedItemFlagged() {
        val huge = "y".repeat(600_000)
        val pack = BatchPacker.pack(
            listOf(sampleRow("sms-huge", huge)),
            json,
            maxBodyBytes = 1_000,
        )
        assertEquals(1, pack.rows.size)
        assertTrue(pack.singleItemExceedsLimit)
    }

    private fun sampleRow(id: String, body: String) = QueuedMessageEntity(
        deviceMsgId = id,
        contentKey = id,
        sender = "+15551234567",
        body = body,
        receivedAt = "2026-11-18T09:45:12Z",
        direction = "inbound",
        simSlot = 0,
        createdAtEpochMs = 1L,
    )
}
