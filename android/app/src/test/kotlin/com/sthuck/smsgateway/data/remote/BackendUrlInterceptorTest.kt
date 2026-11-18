package com.sthuck.smsgateway.data.remote

import com.sthuck.smsgateway.pairing.PairingCredentials
import com.sthuck.smsgateway.pairing.PairingCredentialsReader
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicReference

class BackendUrlInterceptorTest {

    private lateinit var server: MockWebServer

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    @Test
    fun rewritesPlaceholderLocalhostToStoredOrigin() {
        server.enqueue(MockResponse().setResponseCode(204))
        val stored = server.url("/").toString().trimEnd('/')
        val client = OkHttpClient.Builder()
            .addInterceptor(BackendUrlInterceptor(FakeReader(stored)))
            .build()
        client.newCall(
            Request.Builder().url("http://localhost/v1/devices/me").get().build(),
        ).execute().close()
        val recorded = server.takeRequest()
        assertEquals("/v1/devices/me", recorded.path)
        assertEquals(server.port, recorded.requestUrl!!.port)
    }

    @Test
    fun leavesAbsolutePairUrlUntouchedEvenWhenStoredOriginDiffers() {
        val absolute = "http://10.0.2.2:4010/v1/devices/pair".toHttpUrl()
        val seen = AtomicReference<okhttp3.HttpUrl?>(null)
        val client = OkHttpClient.Builder()
            .addInterceptor(
                BackendUrlInterceptor(FakeReader("https://sms.sthuck.info")),
            )
            .addInterceptor(
                Interceptor { chain ->
                    seen.set(chain.request().url)
                    Response.Builder()
                        .request(chain.request())
                        .protocol(Protocol.HTTP_1_1)
                        .code(201)
                        .message("Created")
                        .body("{}".toResponseBody("application/json".toMediaType()))
                        .build()
                },
            )
            .build()
        client.newCall(Request.Builder().url(absolute).get().build()).execute().close()
        assertEquals(absolute, seen.get())
        assertEquals("10.0.2.2", seen.get()!!.host)
        assertEquals(4010, seen.get()!!.port)
    }

    @Test
    fun placeholderDetection() {
        assertTrue(BackendUrlInterceptor.isPlaceholderBase("http://localhost/v1/devices/me".toHttpUrl()))
        assertFalse(
            BackendUrlInterceptor.isPlaceholderBase("http://10.0.2.2:4010/v1/devices/pair".toHttpUrl()),
        )
    }

    private class FakeReader(
        private val serverUrl: String,
    ) : PairingCredentialsReader {
        override suspend fun current() = PairingCredentials(deviceId = "dev", serverUrl = serverUrl)
    }
}
