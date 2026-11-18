package com.sthuck.smsgateway

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.sthuck.smsgateway.pairing.PairingSession
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
    lateinit var pairingSession: PairingSession

    private val statusViewModel: StatusViewModel by viewModels()
    private val pairingViewModel: PairingViewModel by viewModels()

    private val requestSmsPermissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        smsPermissionStore.hasRequested = true
        refreshSmsPermission()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handlePairingIntent(intent)
        setContent {
            SmsGatewayTheme {
                val pairingState by pairingViewModel.uiState.collectAsStateWithLifecycle()
                val statusState by statusViewModel.uiState.collectAsStateWithLifecycle()

                LaunchedEffect(Unit) {
                    pairingSession.rePairRequired.collect {
                        // Credentials already cleared; UI flips via pairingState.pairedDeviceId.
                    }
                }

                LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
                    refreshSmsPermission()
                }

                if (pairingState.pairedDeviceId == null) {
                    PairingScreen(
                        state = pairingState,
                        onCodeChange = pairingViewModel::onCodeChange,
                        onSubmit = { pairingViewModel.submit() },
                        onScanned = pairingViewModel::onScanned,
                    )
                } else {
                    StatusScreen(
                        state = statusState,
                        onGrantSmsClick = {
                            requestSmsPermissions.launch(SMS_PERMISSIONS)
                        },
                        onOpenSettingsClick = { openAppSettings() },
                        onUnpairClick = statusViewModel::requestUnpair,
                        onConfirmUnpair = statusViewModel::confirmUnpair,
                        onDismissUnpair = statusViewModel::dismissUnpair,
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
        if (data.startsWith("smsgw://")) {
            pairingViewModel.onScanned(data)
        }
    }

    private fun refreshSmsPermission() {
        statusViewModel.onPermissionSnapshot(smsPermissionStore.snapshot(this))
    }

    private fun openAppSettings() {
        startActivity(
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", packageName, null),
            ),
        )
    }

    private companion object {
        val SMS_PERMISSIONS = arrayOf(
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_SMS,
        )
    }
}
