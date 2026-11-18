package com.sthuck.smsgateway.data.remote

import com.sthuck.smsgateway.BuildConfig
import com.sthuck.smsgateway.pairing.PairingCredentialStore
import com.sthuck.smsgateway.pairing.ServerUrlValidator
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Rewrites the request host/scheme/port to the configured backend
 * (pairing override, stored URL, or flavour default). Path prefixes on the
 * base URL are not preserved (contract hosts are origin-only).
 */
@Singleton
class BackendUrlInterceptor @Inject constructor(
    private val credentialStore: PairingCredentialStore,
    private val backendUrlOverride: BackendUrlOverride,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val override = backendUrlOverride.peek()
        val stored = runBlocking { credentialStore.current() }.serverUrl
        val raw = override ?: stored
        val base = resolveBase(raw)
        val original = chain.request()
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
}
