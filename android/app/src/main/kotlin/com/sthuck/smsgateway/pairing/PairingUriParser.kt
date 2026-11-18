package com.sthuck.smsgateway.pairing

import java.net.URLDecoder

data class PairingUri(
    val code: String,
    val serverUrl: String?,
)

/**
 * Parses `smsgw://pair?code=<code>&server=<url-encoded base URL>`.
 * Also accepts bare short codes (no scheme) for manual entry.
 */
object PairingUriParser {
    private val CODE_PATTERN = Regex("^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$")

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

        val host = authorityAndPath.substringBefore('/').substringBefore(':')
        val path = authorityAndPath.substringAfter('/', missingDelimiterValue = "")
            .trim('/')
        if (host != "pair" && path != "pair") return null

        val params = parseQuery(query)
        val code = normalizeCode(params["code"] ?: return null) ?: return null
        val server = params["server"]?.takeIf { it.isNotBlank() }
        return PairingUri(code = code, serverUrl = server)
    }

    fun normalizeCode(raw: String): String? {
        val cleaned = raw.trim().uppercase().replace(' ', '-')
        return cleaned.takeIf { CODE_PATTERN.matches(it) }
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
