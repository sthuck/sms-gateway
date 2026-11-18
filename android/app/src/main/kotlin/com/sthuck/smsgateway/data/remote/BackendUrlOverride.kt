package com.sthuck.smsgateway.data.remote

import java.util.concurrent.atomic.AtomicReference
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Override so a pairing attempt can target a candidate server URL without
 * persisting it first (STH-44).
 */
@Singleton
class BackendUrlOverride @Inject constructor() {
    private val overrideUrl = AtomicReference<String?>(null)

    fun peek(): String? = overrideUrl.get()

    suspend fun <T> withUrl(url: String, block: suspend () -> T): T {
        val previous = overrideUrl.getAndSet(url)
        return try {
            block()
        } finally {
            overrideUrl.set(previous)
        }
    }
}
