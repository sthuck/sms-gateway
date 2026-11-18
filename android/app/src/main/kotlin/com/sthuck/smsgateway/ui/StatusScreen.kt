package com.sthuck.smsgateway.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.sthuck.smsgateway.R
import com.sthuck.smsgateway.sms.SmsPermissionState
import com.sthuck.smsgateway.ui.theme.SmsGatewayTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StatusScreen(
    state: StatusUiState,
    onGrantSmsClick: () -> Unit,
    onOpenSettingsClick: () -> Unit,
    onUnpairClick: () -> Unit = {},
    onConfirmUnpairClearQueue: () -> Unit = {},
    onConfirmUnpairKeepQueue: () -> Unit = {},
    onDismissUnpair: () -> Unit = {},
    onRetryParked: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(title = { Text(stringResource(R.string.app_name)) })
        },
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .padding(innerPadding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SmsPermissionCard(
                state = state.smsPermission,
                onGrantSmsClick = onGrantSmsClick,
                onOpenSettingsClick = onOpenSettingsClick,
            )
            StatusRow(stringResource(R.string.status_sms_permission), permissionLabel(state.smsPermission))
            StatusRow(stringResource(R.string.status_flavor), state.flavor)
            StatusRow(stringResource(R.string.status_backend), state.backendUrl)
            StatusRow(stringResource(R.string.status_version), state.versionName)
            StatusRow(stringResource(R.string.status_pairing), state.pairingStatus)
            if (state.deviceId != null) {
                if (state.unpairConfirmVisible) {
                    Text(
                        text = stringResource(R.string.unpair_confirm_body),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Button(
                        onClick = onConfirmUnpairClearQueue,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(stringResource(R.string.unpair_confirm_clear))
                    }
                    OutlinedButton(
                        onClick = onConfirmUnpairKeepQueue,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(stringResource(R.string.unpair_confirm_keep))
                    }
                    OutlinedButton(onClick = onDismissUnpair, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.unpair_cancel))
                    }
                } else {
                    OutlinedButton(onClick = onUnpairClick, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.unpair_action))
                    }
                }
            }
            StatusRow(
                stringResource(R.string.status_queue),
                pluralStringResource(R.plurals.status_queue_count, state.queuedCount, state.queuedCount),
            )
            if (state.recentQueued.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = stringResource(R.string.status_queue_recent),
                    style = MaterialTheme.typography.titleSmall,
                )
                state.recentQueued.forEach { item ->
                    StatusRow(
                        label = item.sender,
                        value = formatQueuedPreview(item),
                    )
                }
            }
            StatusRow(
                stringResource(R.string.status_parked),
                pluralStringResource(
                    R.plurals.status_parked_count,
                    state.parkedCount,
                    state.parkedCount,
                ),
            )
            if (state.parkedCount > 0) {
                OutlinedButton(
                    onClick = onRetryParked,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.status_parked_retry))
                }
            }
            if (state.recentParked.isNotEmpty()) {
                Spacer(Modifier.height(4.dp))
                Text(
                    text = stringResource(R.string.status_parked_recent),
                    style = MaterialTheme.typography.titleSmall,
                )
                state.recentParked.forEach { item ->
                    StatusRow(
                        label = item.sender,
                        value = formatQueuedPreview(item),
                    )
                }
            }
        }
    }
}

private fun formatQueuedPreview(item: QueuedMessagePreview): String = buildString {
    append(item.receivedAt)
    append(" · ")
    append(item.deviceMsgId)
    if (item.simSlot != null) {
        append(" · slot ")
        append(item.simSlot)
    }
    if (!item.lastError.isNullOrBlank()) {
        append(" · ")
        append(item.lastError)
    }
}

@Composable
private fun SmsPermissionCard(
    state: SmsPermissionState,
    onGrantSmsClick: () -> Unit,
    onOpenSettingsClick: () -> Unit,
) {
    if (state == SmsPermissionState.Granted) return
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                text = stringResource(R.string.sms_rationale_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(R.string.sms_rationale_body),
                style = MaterialTheme.typography.bodyMedium,
            )
            Text(
                text = when (state) {
                    SmsPermissionState.Denied -> stringResource(R.string.sms_rationale_denied)
                    SmsPermissionState.PermanentlyDenied ->
                        stringResource(R.string.sms_rationale_permanently_denied)
                    SmsPermissionState.NotRequested,
                    SmsPermissionState.Granted,
                    -> stringResource(R.string.sms_rationale_not_requested)
                },
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (state == SmsPermissionState.PermanentlyDenied) {
                Button(onClick = onOpenSettingsClick, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.sms_open_settings))
                }
            } else {
                Button(onClick = onGrantSmsClick, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.sms_grant))
                }
            }
            if (state == SmsPermissionState.Denied) {
                OutlinedButton(onClick = onOpenSettingsClick, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.sms_open_settings))
                }
            }
        }
    }
}

@Composable
private fun permissionLabel(state: SmsPermissionState): String = stringResource(
    when (state) {
        SmsPermissionState.Granted -> R.string.sms_status_granted
        SmsPermissionState.Denied -> R.string.sms_status_denied
        SmsPermissionState.PermanentlyDenied -> R.string.sms_status_permanently_denied
        SmsPermissionState.NotRequested -> R.string.sms_status_not_requested
    },
)

@Composable
private fun StatusRow(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Text(text = value, style = MaterialTheme.typography.bodyLarge)
    }
}

@Preview(showBackground = true)
@Composable
private fun StatusScreenPreviewDenied() {
    SmsGatewayTheme {
        StatusScreen(
            state = StatusUiState(
                flavor = "dev",
                backendUrl = "http://10.0.2.2:4010",
                versionName = "0.1.0-dev",
                pairingStatus = "Not paired",
                smsPermission = SmsPermissionState.NotRequested,
            ),
            onGrantSmsClick = {},
            onOpenSettingsClick = {},
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun StatusScreenPreviewGranted() {
    SmsGatewayTheme {
        StatusScreen(
            state = StatusUiState(
                flavor = "dev",
                backendUrl = "http://10.0.2.2:4010",
                versionName = "0.1.0-dev",
                pairingStatus = "Not paired",
                smsPermission = SmsPermissionState.Granted,
                queuedCount = 1,
                recentQueued = listOf(
                    QueuedMessagePreview(
                        deviceMsgId = "sms-abc-0",
                        sender = "+15551234567",
                        receivedAt = "2026-11-18T09:45:12Z",
                        simSlot = 0,
                    ),
                ),
            ),
            onGrantSmsClick = {},
            onOpenSettingsClick = {},
        )
    }
}
