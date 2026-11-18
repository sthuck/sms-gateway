package com.sthuck.smsgateway.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sthuck.smsgateway.BuildConfig
import com.sthuck.smsgateway.data.local.QueuedMessageDao
import com.sthuck.smsgateway.pairing.PairingCredentialStore
import com.sthuck.smsgateway.pairing.PairingRepository
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
)

@HiltViewModel
class StatusViewModel @Inject constructor(
    private val queuedMessageDao: QueuedMessageDao,
    private val credentialStore: PairingCredentialStore,
    private val pairingRepository: PairingRepository,
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

    fun requestUnpair() {
        _uiState.update { it.copy(unpairConfirmVisible = true) }
    }

    fun dismissUnpair() {
        _uiState.update { it.copy(unpairConfirmVisible = false) }
    }

    fun confirmUnpair(clearQueue: Boolean) {
        viewModelScope.launch {
            pairingRepository.unpair(clearQueue = clearQueue)
            _uiState.update { it.copy(unpairConfirmVisible = false) }
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
