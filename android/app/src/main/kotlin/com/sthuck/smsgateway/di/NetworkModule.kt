package com.sthuck.smsgateway.di

import com.sthuck.smsgateway.BuildConfig
import com.sthuck.smsgateway.crypto.DeviceKeyStore
import com.sthuck.smsgateway.crypto.DeviceSigner
import com.sthuck.smsgateway.data.remote.BackendUrlInterceptor
import com.sthuck.smsgateway.data.remote.DeviceApi
import com.sthuck.smsgateway.data.remote.RequestSigningInterceptor
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNamingStrategy
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object NetworkModule {

    @Provides
    @Singleton
    fun json(): Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        namingStrategy = JsonNamingStrategy.SnakeCase
    }

    @Provides
    fun deviceSigner(deviceKeyStore: DeviceKeyStore): DeviceSigner = deviceKeyStore.signer()

    @Provides
    @Singleton
    fun okHttpClient(
        backendUrlInterceptor: BackendUrlInterceptor,
        requestSigningInterceptor: RequestSigningInterceptor,
    ): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .addInterceptor(backendUrlInterceptor)
            .addInterceptor(requestSigningInterceptor)
        if (BuildConfig.DEBUG) {
            // BASIC only: message bodies, pairing codes, and signatures must not be logged.
            builder.addInterceptor(
                HttpLoggingInterceptor().apply {
                    level = HttpLoggingInterceptor.Level.BASIC
                },
            )
        }
        return builder.build()
    }

    @Provides
    @Singleton
    fun retrofit(client: OkHttpClient, json: Json): Retrofit {
        val contentType = "application/json".toMediaType()
        // Placeholder; BackendUrlInterceptor rewrites host/scheme/port.
        return Retrofit.Builder()
            .baseUrl("http://localhost/")
            .client(client)
            .addConverterFactory(json.asConverterFactory(contentType))
            .build()
    }

    @Provides
    @Singleton
    fun deviceApi(retrofit: Retrofit): DeviceApi = retrofit.create(DeviceApi::class.java)
}
