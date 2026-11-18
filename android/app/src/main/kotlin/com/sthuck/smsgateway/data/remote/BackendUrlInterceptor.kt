package com.sthuck.smsgateway.data.remote

import com.sthuck.smsgateway.pairing.PairingCredentialStore
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.Response
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Rewrites the request host/scheme/port to the configured backend
 * (pairing `server` param or flavour default). Retrofit is built against a
 * placeholder base URL.
 */
@Singleton
class BackendUrlInterceptor @Inject constructor(
    private val credentialStore: PairingCredentialStore,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val credentials = runBlocking { credentialStore.current() }
        val base = PairingCredentialStore.normalizeBaseUrl(credentials.serverUrl).toHttpUrl()
        val original = chain.request()
        val rewritten = original.url.newBuilder()
            .scheme(base.scheme)
            .host(base.host)
            .port(base.port)
            .build()
        return chain.proceed(original.newBuilder().url(rewritten).build())
    }
}
