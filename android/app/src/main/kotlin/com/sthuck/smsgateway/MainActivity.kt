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
import androidx.compose.runtime.getValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.sthuck.smsgateway.sms.SmsPermissionStore
import com.sthuck.smsgateway.ui.StatusScreen
import com.sthuck.smsgateway.ui.StatusViewModel
import com.sthuck.smsgateway.ui.theme.SmsGatewayTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject
    lateinit var smsPermissionStore: SmsPermissionStore

    private val viewModel: StatusViewModel by viewModels()

    private val requestSmsPermissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) {
        smsPermissionStore.hasRequested = true
        refreshSmsPermission()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            SmsGatewayTheme {
                val state by viewModel.uiState.collectAsStateWithLifecycle()
                LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
                    refreshSmsPermission()
                }
                StatusScreen(
                    state = state,
                    onGrantSmsClick = {
                        requestSmsPermissions.launch(SMS_PERMISSIONS)
                    },
                    onOpenSettingsClick = { openAppSettings() },
                )
            }
        }
    }

    private fun refreshSmsPermission() {
        viewModel.onPermissionSnapshot(smsPermissionStore.snapshot(this))
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
