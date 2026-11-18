package com.sthuck.smsgateway.pairing

import java.net.URLDecoder

data class PairingUri(
    val code: String,
    val serverUrl: String?,
)

/**
 * Parses `smsgw://pair?code=<code>&server=<url-encoded base URL>`.
 * Also accepts bare short codes (no scheme) for manual entry.
 *
 * Codes use the Crockford base32 alphabet (no I/L/O/U); hyphen optional.
 */
object PairingUriParser {
    // Crockford: 0-9 A-H J-N P-T V-Z (excludes I L O U)
    private val CODE_BODY = Regex("^[0-9A-HJKMNP-TV-Z]{4}-?[0-9A-HJKMNP-TV-Z]{4}$")

    fun parse(raw: String): PairingUri? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty()) return null

        if (!trimmed.contains("://")) {
            val code = normalizeCode(trimmed) ?: return null
            return PairingUri(code = code, serverUrl = null)
        }

        val schemeSep = trimmed.indexOf("://")
        if (schemeSep < 0) return null
        val scheme = trimmed.substring(0, schemeSep).lowercase()
        if (scheme != "smsgw") return null

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
        if (host != "pair") return null
        if (pathPart.isNotEmpty()) return null

        val params = parseQuery(query)
        val code = normalizeCode(params["code"] ?: return null) ?: return null
        val server = params["server"]?.takeIf { it.isNotBlank() }
        return PairingUri(code = code, serverUrl = server)
    }

    fun normalizeCode(raw: String): String? {
        val upper = raw.trim().uppercase()
            .replace('I', '1')
            .replace('L', '1')
            .replace('O', '0')
            .replace(' ', '-')
        if (!CODE_BODY.matches(upper)) return null
        val compact = upper.replace("-", "")
        return compact.substring(0, 4) + "-" + compact.substring(4, 8)
    }

    private fun parseQuery(query: String): Map<String, String> {
        if (query.isEmpty()) return emptyMap()
        return query.split('&')
            .mapNotNull { part ->
                if (part.isEmpty()) return@mapNotNull null
                val eq = part.indexOf('=')
                val key = if (eq >= 0) part.substring(0, eq) else part
                val value = if (eq >= 0) part.substring(eq + 1) else ""
                decode(key) to decode(value)
            }
            .toMap()
    }

    private fun decode(value: String): String =
        URLDecoder.decode(value.replace('+', ' '), "UTF-8")
}
