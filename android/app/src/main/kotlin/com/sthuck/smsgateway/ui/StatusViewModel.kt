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
)

data class StatusUiState(
    val flavor: String,
    val backendUrl: String,
    val versionName: String,
    val pairingStatus: String,
    val deviceId: String? = null,
    val smsPermission: SmsPermissionState = SmsPermissionState.NotRequested,
    val queuedCount: Int = 0,
    val recentQueued: List<QueuedMessagePreview> = emptyList(),
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
                queuedMessageDao.observeCount(),
                queuedMessageDao.observeRecent(5),
                credentialStore.credentials,
            ) { count, recent, creds ->
                Triple(count, recent, creds)
            }.collect { (count, recent, creds) ->
                _uiState.update { state ->
                    state.copy(
                        queuedCount = count,
                        recentQueued = recent.map { row ->
                            QueuedMessagePreview(
                                deviceMsgId = row.deviceMsgId,
                                sender = row.sender,
                                receivedAt = row.receivedAt,
                                simSlot = row.simSlot,
                            )
                        },
                        backendUrl = creds.serverUrl,
                        deviceId = creds.deviceId,
                        pairingStatus = if (creds.isPaired) {
                            "Paired (${creds.deviceId})"
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

    fun confirmUnpair() {
        viewModelScope.launch {
            pairingRepository.unpair(clearQueue = true)
            _uiState.update { it.copy(unpairConfirmVisible = false) }
        }
    }
}
