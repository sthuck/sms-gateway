package com.sthuck.smsgateway.upload

import com.sthuck.smsgateway.data.local.QueuedMessageEntity
import com.sthuck.smsgateway.data.remote.dto.DeviceMessage
import com.sthuck.smsgateway.data.remote.dto.Direction
import com.sthuck.smsgateway.data.remote.dto.MessageBatchRequest
import kotlinx.serialization.json.Json

/**
 * Packs outbox rows into a contract-compliant batch: at most
 * [UploadDefaults.MAX_BATCH_MESSAGES] items and at most
 * [UploadDefaults.MAX_BATCH_BODY_BYTES] UTF-8 bytes of the wire JSON.
 */
object BatchPacker {
    fun pack(
        candidates: List<QueuedMessageEntity>,
        json: Json,
        maxMessages: Int = UploadDefaults.MAX_BATCH_MESSAGES,
        maxBodyBytes: Int = UploadDefaults.MAX_BATCH_BODY_BYTES,
    ): PackResult {
        if (candidates.isEmpty()) return PackResult(emptyList(), MessageBatchRequest(emptyList()), 0)

        val chosen = mutableListOf<QueuedMessageEntity>()
        var lastBytes = 0
        for (row in candidates) {
            if (chosen.size >= maxMessages) break
            val trial = chosen + row
            val request = MessageBatchRequest(trial.map { it.toDeviceMessage() })
            val bytes = json.encodeToString(MessageBatchRequest.serializer(), request)
                .toByteArray(Charsets.UTF_8)
                .size
            if (bytes > maxBodyBytes) {
                if (chosen.isEmpty()) {
                    // Single oversized item: still return it so the uploader can park
                    // (payload_too_large) rather than stall the queue.
                    return PackResult(
                        rows = listOf(row),
                        request = request,
                        bodyBytes = bytes,
                        singleItemExceedsLimit = true,
                    )
                }
                break
            }
            chosen.clear()
            chosen.addAll(trial)
            lastBytes = bytes
        }
        val request = MessageBatchRequest(chosen.map { it.toDeviceMessage() })
        return PackResult(chosen, request, lastBytes)
    }

    fun QueuedMessageEntity.toDeviceMessage(): DeviceMessage = DeviceMessage(
        deviceMsgId = deviceMsgId,
        sender = sender,
        body = body,
        receivedAt = receivedAt,
        direction = when (direction.lowercase()) {
            "outbound" -> Direction.Outbound
            else -> Direction.Inbound
        },
        simSlot = simSlot,
    )
}

data class PackResult(
    val rows: List<QueuedMessageEntity>,
    val request: MessageBatchRequest,
    val bodyBytes: Int,
    val singleItemExceedsLimit: Boolean = false,
)
