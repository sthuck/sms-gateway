package com.sthuck.smsgateway.keepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.sthuck.smsgateway.MainActivity
import com.sthuck.smsgateway.R
import com.sthuck.smsgateway.pairing.PairingCredentialStore
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Persistent foreground service (`specialUse`) so the process stays warm for
 * near-real-time SMS enqueue + WorkManager drains. See docs/android-keepalive.md.
 */
@AndroidEntryPoint
class GatewayKeepaliveService : Service() {

    @Inject
    lateinit var credentialStore: PairingCredentialStore

    @Inject
    lateinit var heartbeatClient: HeartbeatClient

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var heartbeatJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIFICATION_ID, notification)
        }
        scope.launch {
            if (!credentialStore.current().isPaired) {
                stopSelf()
                return@launch
            }
            startHeartbeatLoop()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        heartbeatJob?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    private fun startHeartbeatLoop() {
        if (!heartbeatClient.enabled) return
        if (heartbeatJob?.isActive == true) return
        heartbeatJob = scope.launch {
            while (isActive) {
                // Never let heartbeat outcomes affect uploads.
                heartbeatClient.send()
                delay(HEARTBEAT_INTERVAL_MS)
            }
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.keepalive_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = getString(R.string.keepalive_channel_desc)
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val launch = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.keepalive_notification_title))
            .setContentText(getString(R.string.keepalive_notification_text))
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentIntent(launch)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "sms_gateway_keepalive"
        const val NOTIFICATION_ID = 47
        /** Matches docs/contracts/device-heartbeat-draft.md. */
        const val HEARTBEAT_INTERVAL_MS = 15L * 60L * 1000L
    }
}
