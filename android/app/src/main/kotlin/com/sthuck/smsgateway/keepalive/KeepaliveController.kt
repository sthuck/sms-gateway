package com.sthuck.smsgateway.keepalive

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Starts / stops [GatewayKeepaliveService] when the device is paired.
 * Swallows background-start denials (API 31+); boot and foreground paths retry.
 */
@Singleton
class KeepaliveController @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    fun ensureStarted() {
        val intent = Intent(context, GatewayKeepaliveService::class.java)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                @Suppress("DEPRECATION")
                context.startService(intent)
            }
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException and OEM variants.
            Log.w(TAG, "Could not start keepalive FGS (will retry on boot/UI): ${e.javaClass.simpleName}")
        }
    }

    fun stop() {
        context.stopService(Intent(context, GatewayKeepaliveService::class.java))
    }

    private companion object {
        const val TAG = "KeepaliveController"
    }
}
