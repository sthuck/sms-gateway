package com.sthuck.smsgateway.data.remote

import com.sthuck.smsgateway.pairing.AccessHeadersValidator
import com.sthuck.smsgateway.pairing.PairingCredentialsReader
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response
import java.util.Locale
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Attaches custom access headers (e.g. Cloudflare Access service tokens) only
 * when the request's exact scheme+host+port origin matches the authorized target.
 *
 * Must run **after** [BackendUrlInterceptor] (so the destination URL is resolved)
 * and **before** [RequestSigningInterceptor] (so signing retries preserve headers).
 */
@Singleton
class AccessHeadersInterceptor @Inject constructor(
    private val credentialStore: PairingCredentialsReader,
) : Interceptor {

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        if (isPairRequest(request)) {
            val tag = request.tag(PairAccessHeadersTag::class.java)
                ?: return chain.proceed(request)
            if (tag.headers.isEmpty() || originKey(request.url) != tag.serverOrigin) {
                return chain.proceed(request)
            }
            return chain.proceed(withValidatedHeaders(request, tag.headers))
        }

        val creds = runBlocking { credentialStore.current() }
        if (creds.accessHeaders.isEmpty()) {
            return chain.proceed(request)
        }
        val expectedOrigin = originKey(creds.serverUrl) ?: return chain.proceed(request)
        if (originKey(request.url) != expectedOrigin) {
            return chain.proceed(request)
        }
        return chain.proceed(withValidatedHeaders(request, creds.accessHeaders))
    }

    private fun withValidatedHeaders(request: Request, headers: Map<String, String>): Request {
        val validated = when (val result = AccessHeadersValidator.validate(headers)) {
            is AccessHeadersValidator.Result.Ok -> result.headers
            is AccessHeadersValidator.Result.Err -> return request
        }
        val builder = request.newBuilder()
        for ((name, value) in validated) {
            builder.header(name, value)
        }
        return builder.build()
    }

    private fun isPairRequest(request: Request): Boolean =
        request.method.equals("POST", ignoreCase = true) &&
            (
                request.url.encodedPath.endsWith("/v1/devices/pair") ||
                    request.url.encodedPath.endsWith("v1/devices/pair")
                )

    companion object {
        fun originKey(url: HttpUrl): String =
            "${url.scheme.lowercase(Locale.ROOT)}://${url.host.lowercase(Locale.ROOT)}:${url.port}"

        fun originKey(rawUrl: String): String? =
            rawUrl.toHttpUrlOrNull()?.let(::originKey)
    }
}
