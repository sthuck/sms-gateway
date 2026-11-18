package com.sthuck.smsgateway.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sthuck.smsgateway.BuildConfig
import com.sthuck.smsgateway.data.local.QueuedMessageDao
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
    val smsPermission: SmsPermissionState = SmsPermissionState.NotRequested,
    val queuedCount: Int = 0,
    val recentQueued: List<QueuedMessagePreview> = emptyList(),
)

@HiltViewModel
class StatusViewModel @Inject constructor(
    private val queuedMessageDao: QueuedMessageDao,
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
            ) { count, recent -> count to recent }
                .collect { (count, recent) ->
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
                        )
                    }
                }
        }
    }

    fun onPermissionSnapshot(snapshot: SmsPermissionSnapshot) {
        _uiState.update { it.copy(smsPermission = smsPermissionState(snapshot)) }
    }
}
