package com.sthuck.smsgateway.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sthuck.smsgateway.BuildConfig
import com.sthuck.smsgateway.pairing.PairingCredentialStore
import com.sthuck.smsgateway.pairing.PairingRepository
import com.sthuck.smsgateway.pairing.PairingResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class PairingUiState(
    val codeInput: String = "",
    val serverHint: String = BuildConfig.BACKEND_URL,
    val inProgress: Boolean = false,
    val error: String? = null,
    val pairedDeviceId: String? = null,
)

@HiltViewModel
class PairingViewModel @Inject constructor(
    private val pairingRepository: PairingRepository,
    private val credentialStore: PairingCredentialStore,
) : ViewModel() {
    private val _uiState = MutableStateFlow(PairingUiState())
    val uiState: StateFlow<PairingUiState> = _uiState.asStateFlow()

    init {
        viewModelScope.launch {
            credentialStore.credentials.collect { creds ->
                _uiState.update {
                    it.copy(
                        serverHint = creds.serverUrl,
                        pairedDeviceId = creds.deviceId,
                    )
                }
            }
        }
    }

    fun onCodeChange(value: String) {
        _uiState.update { it.copy(codeInput = value, error = null) }
    }

    fun onScanned(raw: String) {
        _uiState.update { it.copy(codeInput = raw, error = null) }
        submit(raw)
    }

    fun submit(raw: String = _uiState.value.codeInput) {
        if (_uiState.value.inProgress) return
        viewModelScope.launch {
            _uiState.update { it.copy(inProgress = true, error = null) }
            when (val result = pairingRepository.pair(raw)) {
                is PairingResult.Success -> {
                    _uiState.update {
                        it.copy(
                            inProgress = false,
                            pairedDeviceId = result.deviceId,
                            serverHint = result.serverUrl,
                            error = null,
                        )
                    }
                }
                is PairingResult.Failure -> {
                    _uiState.update {
                        it.copy(inProgress = false, error = result.message)
                    }
                }
            }
        }
    }
}
