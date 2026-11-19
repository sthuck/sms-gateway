package com.sthuck.smsgateway

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.sthuck.smsgateway.keepalive.BatteryOptimization
import com.sthuck.smsgateway.keepalive.OemSetupLauncher
import com.sthuck.smsgateway.sms.SmsPermissionStore
import com.sthuck.smsgateway.ui.PairingScreen
import com.sthuck.smsgateway.ui.PairingViewModel
import com.sthuck.smsgateway.ui.StatusScreen
import com.sthuck.smsgateway.ui.StatusViewModel
import com.sthuck.smsgateway.ui.theme.SmsGatewayTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject
    lateinit var smsPermissionStore: SmsPermissionStore

    @Inject
    lateinit var batteryOptimization: BatteryOptimization

    private val statusViewModel: StatusViewModel by viewModels()
    private val pairingViewModel: PairingViewModel by viewModels()

    private val requestSmsPermissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        smsPermissionStore.hasRequested = true
        refreshSmsPermission()
    }

    private val requestNotifications = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) {
        refreshSetupSnapshot()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Consume deep link only on the first creation, never on rotation (STH-44).
        if (savedInstanceState == null) {
            handlePairingIntent(intent)
        }
        setContent {
            SmsGatewayTheme {
                val pairingState by pairingViewModel.uiState.collectAsStateWithLifecycle()
                val statusState by statusViewModel.uiState.collectAsStateWithLifecycle()

                LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
                    refreshSmsPermission()
                    refreshSetupSnapshot()
                }

                if (pairingState.pairedDeviceId == null) {
                    PairingScreen(
                        state = pairingState,
                        onCodeChange = pairingViewModel::onCodeChange,
                        onRequestConfirmation = { pairingViewModel.requestConfirmation() },
                        onConfirmPairing = pairingViewModel::confirmPairing,
                        onCancelConfirmation = pairingViewModel::cancelConfirmation,
                        onScanned = pairingViewModel::onScannedOrDeepLink,
                    )
                } else {
                    StatusScreen(
                        state = statusState,
                        onGrantSmsClick = {
                            requestSmsPermissions.launch(SMS_PERMISSIONS)
                        },
                        onOpenSettingsClick = { openAppSettings() },
                        onUnpairClick = statusViewModel::requestUnpair,
                        onConfirmUnpairClearQueue = {
                            statusViewModel.confirmUnpair(clearQueue = true)
                        },
                        onConfirmUnpairKeepQueue = {
                            statusViewModel.confirmUnpair(clearQueue = false)
                        },
                        onDismissUnpair = statusViewModel::dismissUnpair,
                        onRetryParked = statusViewModel::retryParked,
                        onGrantNotificationsClick = {
                            if (Build.VERSION.SDK_INT >= 33) {
                                requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                            }
                        },
                        onRequestBatteryExemptClick = {
                            startActivity(batteryOptimization.requestIgnoreIntent())
                        },
                        onOpenOemSetupClick = {
                            startActivity(
                                OemSetupLauncher.intentFor(this, statusState.oemSetup),
                            )
                        },
                        onOpenOemFallbackClick = {
                            startActivity(
                                Intent(
                                    Intent.ACTION_VIEW,
                                    Uri.parse(statusState.oemSetup.fallbackWebUrl),
                                ),
                            )
                        },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handlePairingIntent(intent)
    }

    private fun handlePairingIntent(intent: Intent?) {
        val data = intent?.data?.toString() ?: return
        if (!data.startsWith("smsgw://")) return
        // One-shot: clear so recreation / redelivery cannot replay.
        intent.data = null
        setIntent(Intent(intent).apply { this.data = null })
        pairingViewModel.onScannedOrDeepLink(data)
    }

    private fun refreshSmsPermission() {
        statusViewModel.onPermissionSnapshot(smsPermissionStore.snapshot(this))
    }

    private fun refreshSetupSnapshot() {
        val notificationsGranted = if (Build.VERSION.SDK_INT < 33) {
            true
        } else {
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
        }
        statusViewModel.onSetupSnapshot(notificationsGranted)
    }

    private fun openAppSettings() {
        startActivity(batteryOptimization.appSettingsIntent())
    }

    private companion object {
        val SMS_PERMISSIONS = arrayOf(
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_SMS,
        )
    }
}
