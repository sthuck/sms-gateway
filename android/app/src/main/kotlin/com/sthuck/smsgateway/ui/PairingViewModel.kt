package com.sthuck.smsgateway.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.sthuck.smsgateway.BuildConfig
import com.sthuck.smsgateway.pairing.PairingCredentialStore
import com.sthuck.smsgateway.pairing.PairingRepository
import com.sthuck.smsgateway.pairing.PairingResult
import com.sthuck.smsgateway.pairing.PairingUriParser
import com.sthuck.smsgateway.pairing.ServerUrlValidator
import com.sthuck.smsgateway.upload.UploadScheduler
import androidx.work.ExistingWorkPolicy
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

data class PairingConfirmation(
    val code: String,
    val serverUrl: String,
    val hostLabel: String,
    val requiresExtraWarning: Boolean,
    val replacingExisting: Boolean,
)

data class PairingUiState(
    val codeInput: String = "",
    val serverHint: String = BuildConfig.BACKEND_URL,
    val inProgress: Boolean = false,
    val error: String? = null,
    val pairedDeviceId: String? = null,
    val confirmation: PairingConfirmation? = null,
)

@HiltViewModel
class PairingViewModel @Inject constructor(
    private val pairingRepository: PairingRepository,
    private val credentialStore: PairingCredentialStore,
    private val uploadScheduler: UploadScheduler,
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

    /** Prefill from QR / deep link — never auto-submits (STH-43). */
    fun onScannedOrDeepLink(raw: String) {
        if (_uiState.value.pairedDeviceId != null) {
            // Ignore inbound links while paired; re-pair only via explicit UI confirm.
            return
        }
        prepareConfirmation(raw)
    }

    /** Manual "Pair" tap — show confirmation, do not call the API yet. */
    fun requestConfirmation(raw: String = _uiState.value.codeInput) {
        prepareConfirmation(raw)
    }

    fun cancelConfirmation() {
        _uiState.update { it.copy(confirmation = null, error = null) }
    }

    fun confirmPairing() {
        val pending = _uiState.value.confirmation ?: return
        if (_uiState.value.inProgress) return
        viewModelScope.launch {
            _uiState.update { it.copy(inProgress = true, error = null) }
            when (val result = pairingRepository.pair(pending.code, pending.serverUrl)) {
                is PairingResult.Success -> {
                    uploadScheduler.enqueueUpload(ExistingWorkPolicy.REPLACE)
                    _uiState.update {
                        it.copy(
                            inProgress = false,
                            pairedDeviceId = result.deviceId,
                            serverHint = result.serverUrl,
                            codeInput = "",
                            confirmation = null,
                            error = null,
                        )
                    }
                }
                is PairingResult.Failure -> {
                    _uiState.update {
                        it.copy(
                            inProgress = false,
                            confirmation = null,
                            codeInput = "",
                            error = result.message,
                        )
                    }
                }
            }
        }
    }

    private fun prepareConfirmation(raw: String) {
        val parsed = PairingUriParser.parse(raw)
        if (parsed == null) {
            _uiState.update {
                it.copy(
                    error = "Enter a valid pairing code (e.g. 7K3M-9Q2P) or scan the QR.",
                    confirmation = null,
                )
            }
            return
        }
        val fallback = _uiState.value.serverHint
        when (
            val validated = ServerUrlValidator.validate(
                raw = parsed.serverUrl,
                fallback = fallback,
            )
        ) {
            is ServerUrlValidator.Result.Err -> {
                _uiState.update {
                    it.copy(error = validated.message, confirmation = null, codeInput = parsed.code)
                }
            }
            is ServerUrlValidator.Result.Ok -> {
                val replacing = _uiState.value.pairedDeviceId != null
                _uiState.update {
                    it.copy(
                        codeInput = parsed.code,
                        error = null,
                        confirmation = PairingConfirmation(
                            code = parsed.code,
                            serverUrl = validated.value.url,
                            hostLabel = validated.value.hostWithPort,
                            requiresExtraWarning = validated.value.requiresExtraWarning,
                            replacingExisting = replacing,
                        ),
                    )
                }
            }
        }
    }
}
