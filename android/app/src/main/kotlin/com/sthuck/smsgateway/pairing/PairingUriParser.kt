package com.sthuck.smsgateway.pairing

import java.net.URLDecoder
import java.util.Locale

data class PairingUri(
    val code: String,
    val serverUrl: String?,
    val accessHeaders: Map<String, String> = emptyMap(),
)

/**
 * Parses `smsgw://pair?code=<code>&server=<url-encoded base URL>[&headers=<base64url json>]`.
 * Also accepts bare short codes (no scheme) for manual entry.
 *
 * Codes use the Crockford base32 alphabet (no I/L/O/U); hyphen optional.
 */
object PairingUriParser {
    // Crockford: 0-9 A-H J-N P-T V-Z (excludes I L O U)
    private val CODE_BODY = Regex("^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$")
    private const val GENERIC_ERROR =
        "Enter a valid pairing code (e.g. 7K3M-9Q2P) or scan the QR."

    sealed class ParseResult {
        data class Ok(val value: PairingUri) : ParseResult()
        data class Err(val message: String) : ParseResult()
    }

    fun parse(raw: String): PairingUri? = when (val result = parseDetailed(raw)) {
        is ParseResult.Ok -> result.value
        is ParseResult.Err -> null
    }

    fun parseDetailed(raw: String): ParseResult {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return ParseResult.Err(GENERIC_ERROR)

        if (!trimmed.contains("://")) {
            val code = normalizeCode(trimmed) ?: return ParseResult.Err(GENERIC_ERROR)
            return ParseResult.Ok(PairingUri(code = code, serverUrl = null))
        }

        val schemeSep = trimmed.indexOf("://")
        if (schemeSep < 0) return ParseResult.Err(GENERIC_ERROR)
        val scheme = trimmed.substring(0, schemeSep).lowercase(Locale.ROOT)
        if (scheme != "smsgw") return ParseResult.Err(GENERIC_ERROR)

        val afterScheme = trimmed.substring(schemeSep + 3)
        val queryStart = afterScheme.indexOf('?')
        val authorityAndPath = if (queryStart >= 0) {
            afterScheme.substring(0, queryStart)
        } else {
            afterScheme
        }
        val query = if (queryStart >= 0) afterScheme.substring(queryStart + 1) else ""

        // Require host "pair" and no path (reject smsgw://anything/pair).
        val host = authorityAndPath.substringBefore('/').substringBefore(':')
        val pathPart = authorityAndPath.substringAfter('/', missingDelimiterValue = "")
        if (host != "pair" || pathPart.isNotEmpty()) {
            return ParseResult.Err(GENERIC_ERROR)
        }

        val params = parseQuery(query) ?: return ParseResult.Err(GENERIC_ERROR)
        val codeRaw = params["code"]?.singleOrNull() ?: return ParseResult.Err(GENERIC_ERROR)
        val code = normalizeCode(codeRaw) ?: return ParseResult.Err(GENERIC_ERROR)
        val server = params["server"]?.lastOrNull()?.takeIf { it.isNotBlank() }

        val headersParam = params["headers"]
        val accessHeaders = if (headersParam != null) {
            if (headersParam.size != 1) {
                return ParseResult.Err("Duplicate access headers parameter in pairing URI.")
            }
            when (val decoded = AccessHeadersValidator.decodeBase64UrlJson(headersParam.single())) {
                is AccessHeadersValidator.Result.Ok -> decoded.headers
                is AccessHeadersValidator.Result.Err -> return ParseResult.Err(decoded.message)
            }
        } else {
            emptyMap()
        }

        return ParseResult.Ok(
            PairingUri(
                code = code,
                serverUrl = server,
                accessHeaders = accessHeaders,
            ),
        )
    }

    fun normalizeCode(raw: String): String? {
        val upper = raw.trim().uppercase(Locale.ROOT)
            .replace('I', '1')
            .replace('L', '1')
            .replace('O', '0')
            .replace(' ', '-')
        if (!CODE_BODY.matches(upper)) return null
        val compact = upper.replace("-", "")
        return compact.substring(0, 4) + "-" + compact.substring(4, 8)
    }

    private fun parseQuery(query: String): Map<String, List<String>>? {
        if (query.isEmpty()) return emptyMap()
        val result = LinkedHashMap<String, MutableList<String>>()
        for (part in query.split('&')) {
            if (part.isEmpty()) continue
            val eq = part.indexOf('=')
            val rawKey = if (eq >= 0) part.substring(0, eq) else part
            val rawValue = if (eq >= 0) part.substring(eq + 1) else ""
            val key = try {
                decode(rawKey)
            } catch (_: IllegalArgumentException) {
                return null
            }
            val value = try {
                decode(rawValue)
            } catch (_: IllegalArgumentException) {
                return null
            }
            result.getOrPut(key) { mutableListOf() }.add(value)
        }
        return result
    }

    private fun decode(value: String): String =
        URLDecoder.decode(value, "UTF-8")
}
