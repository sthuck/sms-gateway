package com.sthuck.smsgateway.pairing

import com.sthuck.smsgateway.crypto.Base64Url
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.Locale

/**
 * Validates and decodes custom pairing access headers (e.g. Cloudflare Access
 * service-token headers) per the Frozen Shared Wire Contract (STH-60 / STH-61).
 */
object AccessHeadersValidator {
    const val MAX_JSON_BYTES = 2048
    const val MAX_HEADER_COUNT = 8
    const val MAX_NAME_LENGTH = 128
    const val MAX_VALUE_LENGTH = 1024

    /** Case-insensitive reserved headers that custom pairing headers may never override. */
    val RESERVED_HEADERS: Set<String> = setOf(
        "host",
        "authorization",
        "proxy-authorization",
        "cookie",
        "origin",
        "referer",
        "content-type",
        "content-length",
        "content-encoding",
        "transfer-encoding",
        "connection",
        "x-csrf-token",
        "x-device-id",
        "x-timestamp",
        "x-nonce",
        "x-content-sha256",
        "x-signature",
    )

    private val json = Json {
        ignoreUnknownKeys = false
        explicitNulls = false
    }
    private val mapSerializer = MapSerializer(String.serializer(), String.serializer())

    sealed class Result {
        data class Ok(val headers: Map<String, String>) : Result()
        data class Err(val message: String) : Result()
    }

    fun decodeBase64UrlJson(encoded: String): Result {
        if (encoded.isEmpty()) {
            return Result.Err("Access headers parameter must not be empty.")
        }
        val bytes = try {
            Base64Url.decode(encoded)
        } catch (_: IllegalArgumentException) {
            return Result.Err("Access headers must be valid unpadded base64url.")
        }
        if (bytes.size > MAX_JSON_BYTES) {
            return Result.Err("Access headers exceed the ${MAX_JSON_BYTES}-byte limit.")
        }
        val jsonText = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        } catch (_: Exception) {
            return Result.Err("Access headers must be valid UTF-8 JSON.")
        }
        return decodePlainJson(jsonText)
    }

    fun decodePlainJson(jsonText: String): Result {
        if (jsonText.toByteArray(Charsets.UTF_8).size > MAX_JSON_BYTES) {
            return Result.Err("Access headers exceed the ${MAX_JSON_BYTES}-byte limit.")
        }
        val element = try {
            json.parseToJsonElement(jsonText)
        } catch (_: Exception) {
            return Result.Err("Access headers must be valid JSON.")
        }
        if (element !is JsonObject) {
            return Result.Err("Access headers must be a JSON object.")
        }
        if (element.isEmpty()) {
            return Result.Err("Access headers must not be empty.")
        }
        val map = LinkedHashMap<String, String>(element.size)
        for ((key, value) in element) {
            if (value !is JsonPrimitive || !value.isString) {
                return Result.Err("Access header values must all be strings.")
            }
            map[key] = value.content
        }
        return validate(map)
    }

    fun validate(headers: Map<String, String>): Result {
        if (headers.isEmpty()) {
            return Result.Err("Access headers must not be empty.")
        }
        if (headers.size > MAX_HEADER_COUNT) {
            return Result.Err("Too many access headers (max $MAX_HEADER_COUNT).")
        }
        val seenLowercase = HashSet<String>(headers.size)
        for ((name, value) in headers) {
            if (name.length !in 1..MAX_NAME_LENGTH || !name.all(::isTokenChar)) {
                return Result.Err("Access headers contain an invalid header name.")
            }
            val lower = name.lowercase(Locale.ROOT)
            if (!seenLowercase.add(lower)) {
                return Result.Err("Duplicate access header name: $name.")
            }
            if (lower in RESERVED_HEADERS) {
                return Result.Err("Reserved header name is not allowed: $name.")
            }
            if (value.length !in 1..MAX_VALUE_LENGTH) {
                return Result.Err("Access header '$name' has an invalid value length.")
            }
            if (value.trim() != value || !value.all(::isPrintableAscii)) {
                return Result.Err(
                    "Access header '$name' contains invalid characters or surrounding whitespace.",
                )
            }
        }
        val encodedBytes = encodeCompactJson(headers).toByteArray(Charsets.UTF_8).size
        if (encodedBytes > MAX_JSON_BYTES) {
            return Result.Err("Access headers exceed the ${MAX_JSON_BYTES}-byte limit.")
        }
        return Result.Ok(headers.toMap())
    }

    fun encodeCompactJson(headers: Map<String, String>): String =
        json.encodeToString(mapSerializer, headers)

    private fun isTokenChar(ch: Char): Boolean =
        ch in '0'..'9' ||
            ch in 'A'..'Z' ||
            ch in 'a'..'z' ||
            ch in "!#$%&'*+-.^_`|~"

    private fun isPrintableAscii(ch: Char): Boolean =
        ch in '\u0020'..'\u007E'
}
