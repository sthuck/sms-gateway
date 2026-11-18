package com.sthuck.smsgateway.pairing

import com.sthuck.smsgateway.BuildConfig
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Validates and normalises pairing `server` base URLs.
 *
 * - Prod: https only; allow-listed hosts (default `sms.sthuck.info`) or
 *   explicit extra confirmation for any other https host.
 * - Dev: http only for `10.0.2.2` / localhost / 127.0.0.1 (emulator mock),
 *   plus https for anything else.
 * - No userinfo, no fragment, path must be empty or `/` (stripped).
 */
object ServerUrlValidator {

    val PROD_ALLOWLIST = setOf("sms.sthuck.info")
    private val DEV_CLEARTEXT_HOSTS = setOf("10.0.2.2", "localhost", "127.0.0.1")

    data class ValidatedServer(
        /** Normalised base URL without trailing slash. */
        val url: String,
        val hostWithPort: String,
        /** True when prod (or unexpected) host is outside the allow-list. */
        val requiresExtraWarning: Boolean,
    )

    sealed class Result {
        data class Ok(val value: ValidatedServer) : Result()
        data class Err(val message: String) : Result()
    }

    fun validate(
        raw: String?,
        isDevFlavor: Boolean = BuildConfig.FLAVOR == "dev",
        fallback: String = BuildConfig.BACKEND_URL,
    ): Result {
        val candidate = (raw?.takeIf { it.isNotBlank() } ?: fallback).trim()
        val parsed = candidate.toHttpUrlOrNull()
            ?: return Result.Err("Server URL is not a valid http(s) URL.")
        return validateHttpUrl(parsed, isDevFlavor)
    }

    fun validateHttpUrl(url: HttpUrl, isDevFlavor: Boolean): Result {
        if (!url.username.isEmpty() || !url.password.isEmpty()) {
            return Result.Err("Server URL must not include userinfo.")
        }
        if (url.fragment != null) {
            return Result.Err("Server URL must not include a fragment.")
        }
        val path = url.encodedPath
        if (path.isNotEmpty() && path != "/") {
            return Result.Err("Server URL must not include a path (got \"$path\").")
        }
        if (url.encodedQuery != null) {
            return Result.Err("Server URL must not include a query string.")
        }

        val scheme = url.scheme.lowercase()
        val host = url.host.lowercase()
        when {
            isDevFlavor && scheme == "http" -> {
                if (host !in DEV_CLEARTEXT_HOSTS) {
                    return Result.Err(
                        "Dev cleartext HTTP is only allowed for 10.0.2.2 / localhost.",
                    )
                }
            }
            isDevFlavor && scheme == "https" -> Unit
            !isDevFlavor && scheme == "https" -> Unit
            !isDevFlavor && scheme == "http" ->
                return Result.Err("Production pairing requires HTTPS.")
            else -> return Result.Err("Unsupported URL scheme: $scheme")
        }

        val normalised = url.newBuilder()
            .encodedPath("/")
            .query(null)
            .fragment(null)
            .build()
            .toString()
            .trimEnd('/')

        val hostWithPort = buildString {
            append(host)
            val defaultPort = if (scheme == "https") 443 else 80
            if (url.port != defaultPort) {
                append(':')
                append(url.port)
            }
        }

        val requiresWarning = if (isDevFlavor) {
            false
        } else {
            host !in PROD_ALLOWLIST
        }

        return Result.Ok(
            ValidatedServer(
                url = normalised,
                hostWithPort = hostWithPort,
                requiresExtraWarning = requiresWarning,
            ),
        )
    }
}
