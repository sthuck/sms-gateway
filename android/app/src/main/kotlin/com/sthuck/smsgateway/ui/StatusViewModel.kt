package com.sthuck.smsgateway.ui

import android.os.Build
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sthuck.smsgateway.BuildConfig
import com.sthuck.smsgateway.data.local.QueuedMessageDao
import com.sthuck.smsgateway.keepalive.BatteryOptimization
import com.sthuck.smsgateway.keepalive.KeepaliveController
import com.sthuck.smsgateway.keepalive.OemSetupCatalog
import com.sthuck.smsgateway.keepalive.OemSetupTarget
import com.sthuck.smsgateway.pairing.PairingCredentialStore
import com.sthuck.smsgateway.pairing.PairingRepository
import com.sthuck.smsgateway.upload.UploadDefaults
import com.sthuck.smsgateway.upload.UploadScheduler
import androidx.work.ExistingWorkPolicy
import com.sthuck.smsgateway.sms.SmsPermissionSnapshot
import com.sthuck.smsgateway.sms.SmsPermissionState
import com.sthuck.smsgateway.sms.smsPermissionState
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject
import java.util.concurrent.TimeUnit

data class QueuedMessagePreview(
    val deviceMsgId: String,
    val sender: String,
    val receivedAt: String,
    val simSlot: Int?,
    val lastError: String? = null,
)

data class StatusUiState(
    val flavor: String,
    val backendUrl: String,
    val versionName: String,
    val pairingStatus: String,
    val deviceId: String? = null,
    val smsPermission: SmsPermissionState = SmsPermissionState.NotRequested,
    val queuedCount: Int = 0,
    val parkedCount: Int = 0,
    val recentQueued: List<QueuedMessagePreview> = emptyList(),
    val recentParked: List<QueuedMessagePreview> = emptyList(),
    val unpairConfirmVisible: Boolean = false,
    val outboxMaxRows: Int = UploadDefaults.MAX_OUTBOX_ROWS,
    val outboxTtlDays: Int = TimeUnit.MILLISECONDS.toDays(UploadDefaults.OUTBOX_TTL_MS).toInt(),
    val notificationsGranted: Boolean = true,
    val batteryExempt: Boolean = false,
    val oemSetup: OemSetupTarget = OemSetupCatalog.forManufacturer(Build.MANUFACTURER),
)

@HiltViewModel
class StatusViewModel @Inject constructor(
    private val queuedMessageDao: QueuedMessageDao,
    private val credentialStore: PairingCredentialStore,
    private val pairingRepository: PairingRepository,
    private val uploadScheduler: UploadScheduler,
    private val keepaliveController: KeepaliveController,
    private val batteryOptimization: BatteryOptimization,
) : ViewModel() {
    private val _uiState = MutableStateFlow(
        StatusUiState(
            flavor = BuildConfig.FLAVOR,
            backendUrl = BuildConfig.BACKEND_URL,
            versionName = BuildConfig.VERSION_NAME,
            pairingStatus = "Not paired",
        ),
    )
    val uiState: StateFlow<StatusUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            combine(
                queuedMessageDao.observePendingCount(),
                queuedMessageDao.observeParkedCount(),
                queuedMessageDao.observePendingRecent(5),
                queuedMessageDao.observeParkedRecent(5),
                credentialStore.credentials,
            ) { pending, parked, recentPending, recentParked, creds ->
                StatusSnapshot(pending, parked, recentPending, recentParked, creds)
            }.collect { snap ->
                _uiState.update { state ->
                    state.copy(
                        queuedCount = snap.pending,
                        parkedCount = snap.parked,
                        recentQueued = snap.recentPending.map { row ->
                            QueuedMessagePreview(
                                deviceMsgId = row.deviceMsgId,
                                sender = row.sender,
                                receivedAt = row.receivedAt,
                                simSlot = row.simSlot,
                                lastError = row.lastError,
                            )
                        },
                        recentParked = snap.recentParked.map { row ->
                            QueuedMessagePreview(
                                deviceMsgId = row.deviceMsgId,
                                sender = row.sender,
                                receivedAt = row.receivedAt,
                                simSlot = row.simSlot,
                                lastError = row.lastError,
                            )
                        },
                        backendUrl = snap.creds.serverUrl,
                        deviceId = snap.creds.deviceId,
                        pairingStatus = if (snap.creds.isPaired) {
                            "Paired (${snap.creds.deviceId})"
                        } else {
                            "Not paired"
                        },
                    )
                }
            }
        }
    }

    fun onPermissionSnapshot(snapshot: SmsPermissionSnapshot) {
        _uiState.update { it.copy(smsPermission = smsPermissionState(snapshot)) }
    }

    fun onSetupSnapshot(notificationsGranted: Boolean) {
        _uiState.update {
            it.copy(
                notificationsGranted = notificationsGranted,
                batteryExempt = batteryOptimization.isIgnoringBatteryOptimizations(),
                oemSetup = OemSetupCatalog.forManufacturer(Build.MANUFACTURER),
            )
        }
        if (_uiState.value.deviceId != null) {
            keepaliveController.ensureStarted()
        }
    }

    fun requestUnpair() {
        _uiState.update { it.copy(unpairConfirmVisible = true) }
    }

    fun dismissUnpair() {
        _uiState.update { it.copy(unpairConfirmVisible = false) }
    }

    fun confirmUnpair(clearQueue: Boolean) {
        viewModelScope.launch {
            pairingRepository.unpair(clearQueue = clearQueue)
            keepaliveController.stop()
            _uiState.update { it.copy(unpairConfirmVisible = false) }
        }
    }

    fun retryParked() {
        viewModelScope.launch {
            queuedMessageDao.unparkAll(System.currentTimeMillis())
            uploadScheduler.enqueueUpload(ExistingWorkPolicy.REPLACE)
        }
    }

    private data class StatusSnapshot(
        val pending: Int,
        val parked: Int,
        val recentPending: List<com.sthuck.smsgateway.data.local.QueuedMessageEntity>,
        val recentParked: List<com.sthuck.smsgateway.data.local.QueuedMessageEntity>,
        val creds: com.sthuck.smsgateway.pairing.PairingCredentials,
    )
}
