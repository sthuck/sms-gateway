package com.sthuck.smsgateway.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sthuck.smsgateway.sms.SmsPermissionState
import com.sthuck.smsgateway.ui.theme.SmsGatewayTheme
import com.sthuck.smsgateway.upload.UploadDefaults
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/**
 * Captures the main Compose surfaces for CI artifact / PR docs.
 * Uses synthetic UI state only — no real pairing codes, device ids, or SMS bodies.
 */
@RunWith(AndroidJUnit4::class)
class UiScreenshotTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun capturePairingEntry() {
        composeRule.setContent {
            SmsGatewayTheme {
                PairingScreen(
                    state = PairingUiState(
                        codeInput = "",
                        serverHint = "https://example.test",
                    ),
                    onCodeChange = {},
                    onRequestConfirmation = {},
                    onConfirmPairing = {},
                    onCancelConfirmation = {},
                    onScanned = {},
                )
            }
        }
        composeRule.waitForIdle()
        val file = ScreenshotHelper.capture(composeRule.onRoot(), "01-pairing-entry")
        assertTrue(file.exists() && file.length() > 0L)
    }

    @Test
    fun capturePairingConfirmation() {
        composeRule.setContent {
            SmsGatewayTheme {
                PairingScreen(
                    state = PairingUiState(
                        codeInput = "ABCD-EFGH",
                        serverHint = "https://example.test",
                        confirmation = PairingConfirmation(
                            code = "ABCD-EFGH",
                            serverUrl = "https://example.test",
                            hostLabel = "example.test",
                            requiresExtraWarning = true,
                            replacingExisting = false,
                        ),
                    ),
                    onCodeChange = {},
                    onRequestConfirmation = {},
                    onConfirmPairing = {},
                    onCancelConfirmation = {},
                    onScanned = {},
                )
            }
        }
        composeRule.waitForIdle()
        val file = ScreenshotHelper.capture(composeRule.onRoot(), "02-pairing-confirm")
        assertTrue(file.exists() && file.length() > 0L)
    }

    @Test
    fun captureStatusWithParkedRetry() {
        composeRule.setContent {
            SmsGatewayTheme {
                StatusScreen(
                    state = StatusUiState(
                        flavor = "dev",
                        backendUrl = "https://example.test",
                        versionName = "0.1.0-dev",
                        pairingStatus = "Paired (dev-device-demo)",
                        deviceId = "dev-device-demo",
                        smsPermission = SmsPermissionState.Granted,
                        queuedCount = 1,
                        parkedCount = 1,
                        recentQueued = listOf(
                            QueuedMessagePreview(
                                deviceMsgId = "sms-demo00000000000000000000000001-0",
                                sender = "+15550001111",
                                receivedAt = "2026-11-18T12:00:00Z",
                                simSlot = 0,
                            ),
                        ),
                        recentParked = listOf(
                            QueuedMessagePreview(
                                deviceMsgId = "sms-demo00000000000000000000000002-0",
                                sender = "+15550002222",
                                receivedAt = "2026-11-10T12:00:00Z",
                                simSlot = 0,
                                lastError = "${UploadDefaults.PARK_REASON_EXPIRED_TTL}: older than outbox TTL",
                            ),
                        ),
                        outboxMaxRows = UploadDefaults.MAX_OUTBOX_ROWS,
                        outboxTtlDays = TimeUnit.MILLISECONDS.toDays(UploadDefaults.OUTBOX_TTL_MS).toInt(),
                    ),
                    onGrantSmsClick = {},
                    onOpenSettingsClick = {},
                    onUnpairClick = {},
                    onRetryParked = {},
                )
            }
        }
        composeRule.waitForIdle()
        val file = ScreenshotHelper.capture(composeRule.onRoot(), "03-status-parked-retry")
        assertTrue(file.exists() && file.length() > 0L)
    }

    @Test
    fun captureSmsPermissionRationale() {
        composeRule.setContent {
            SmsGatewayTheme {
                StatusScreen(
                    state = StatusUiState(
                        flavor = "dev",
                        backendUrl = "https://example.test",
                        versionName = "0.1.0-dev",
                        pairingStatus = "Not paired",
                        smsPermission = SmsPermissionState.NotRequested,
                        queuedCount = 0,
                        parkedCount = 0,
                    ),
                    onGrantSmsClick = {},
                    onOpenSettingsClick = {},
                )
            }
        }
        composeRule.waitForIdle()
        val file = ScreenshotHelper.capture(composeRule.onRoot(), "04-permission-rationale")
        assertTrue(file.exists() && file.length() > 0L)
    }
}
