package com.sthuck.smsgateway.data.remote

import com.sthuck.smsgateway.BuildConfig
import com.sthuck.smsgateway.pairing.PairingCredentialsReader
import com.sthuck.smsgateway.pairing.ServerUrlValidator
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Rewrites placeholder Retrofit base URLs (`localhost`) to the stored
 * backend origin. Absolute URLs (e.g. pairing `@Url`) are left untouched
 * so a candidate pair host never hijacks uploader/status traffic.
 */
@Singleton
class BackendUrlInterceptor @Inject constructor(
    private val credentialStore: PairingCredentialsReader,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        if (!isPlaceholderBase(original.url)) {
            return chain.proceed(original)
        }
        val stored = runBlocking { credentialStore.current() }.serverUrl
        val base = resolveBase(stored)
        val rewritten = original.url.newBuilder()
            .scheme(base.scheme)
            .host(base.host)
            .port(base.port)
            .build()
        return chain.proceed(original.newBuilder().url(rewritten).build())
    }

    private fun resolveBase(raw: String) =
        when (val validated = ServerUrlValidator.validate(raw)) {
            is ServerUrlValidator.Result.Ok ->
                validated.value.url.toHttpUrlOrNull()
                    ?: BuildConfig.BACKEND_URL.toHttpUrlOrNull()!!
            is ServerUrlValidator.Result.Err ->
                BuildConfig.BACKEND_URL.toHttpUrlOrNull()!!
        }

    companion object {
        /** Retrofit NetworkModule placeholder host. */
        fun isPlaceholderBase(url: HttpUrl): Boolean =
            url.host.equals("localhost", ignoreCase = true)
    }
}
