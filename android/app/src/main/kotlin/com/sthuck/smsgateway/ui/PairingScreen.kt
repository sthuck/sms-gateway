package com.sthuck.smsgateway.ui

import android.Manifest
import android.content.pm.PackageManager
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.sthuck.smsgateway.R
import com.sthuck.smsgateway.pairing.RePairReason
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

@Composable
fun PairingScreen(
    state: PairingUiState,
    onCodeChange: (String) -> Unit,
    onRequestConfirmation: () -> Unit,
    onConfirmPairing: () -> Unit,
    onCancelConfirmation: () -> Unit,
    onScanned: (String) -> Unit,
) {
    val context = LocalContext.current
    var cameraGranted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> cameraGranted = granted }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            text = stringResource(R.string.pairing_title),
            style = MaterialTheme.typography.headlineSmall,
        )
        Text(
            text = stringResource(R.string.pairing_body),
            style = MaterialTheme.typography.bodyMedium,
        )
        state.rePairReason?.let { reason ->
            Text(
                text = stringResource(
                    when (reason) {
                        RePairReason.REVOKED -> R.string.pairing_revoked_banner
                        RePairReason.UNKNOWN -> R.string.pairing_unknown_banner
                        RePairReason.KEY_MISSING -> R.string.pairing_key_missing_banner
                        RePairReason.OTHER -> R.string.pairing_unknown_banner
                    },
                ),
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        Text(
            text = stringResource(R.string.pairing_server_hint, state.serverHint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        val confirmation = state.confirmation
        if (confirmation != null) {
            Text(
                text = stringResource(R.string.pairing_confirm_title),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(
                    R.string.pairing_confirm_body,
                    confirmation.code,
                    confirmation.hostLabel,
                ),
                style = MaterialTheme.typography.bodyMedium,
            )
            if (confirmation.requiresExtraWarning) {
                Text(
                    text = stringResource(
                        R.string.pairing_confirm_unlisted_host,
                        confirmation.hostLabel,
                    ),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            if (confirmation.replacingExisting) {
                Text(
                    text = stringResource(R.string.pairing_confirm_replace),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            Button(
                onClick = onConfirmPairing,
                enabled = !state.inProgress,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (state.inProgress) {
                    CircularProgressIndicator(
                        modifier = Modifier.height(20.dp),
                        strokeWidth = 2.dp,
                    )
                } else {
                    Text(stringResource(R.string.pairing_confirm_action))
                }
            }
            OutlinedButton(
                onClick = onCancelConfirmation,
                enabled = !state.inProgress,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.pairing_confirm_cancel))
            }
        } else {
            if (cameraGranted) {
                QrScanner(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(240.dp),
                    onBarcode = onScanned,
                    enabled = !state.inProgress,
                )
            } else {
                Button(onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) }) {
                    Text(stringResource(R.string.pairing_enable_camera))
                }
            }

            OutlinedTextField(
                value = state.codeInput,
                onValueChange = onCodeChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.pairing_code_label)) },
                singleLine = true,
                enabled = !state.inProgress,
            )

            if (state.error != null) {
                Text(
                    text = state.error,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }

            Button(
                onClick = onRequestConfirmation,
                enabled = !state.inProgress && state.codeInput.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.pairing_submit))
            }
        }
        Spacer(Modifier.height(24.dp))
    }
}

@OptIn(ExperimentalGetImage::class)
@Composable
private fun QrScanner(
    modifier: Modifier = Modifier,
    onBarcode: (String) -> Unit,
    enabled: Boolean,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val analysisExecutor = remember { Executors.newSingleThreadExecutor() }
    val handled = remember { AtomicBoolean(false) }
    val enabledRef = remember { AtomicReference(enabled) }
    LaunchedEffect(enabled) {
        enabledRef.set(enabled)
        if (enabled) {
            handled.set(false)
        }
    }

    DisposableEffect(Unit) {
        onDispose { analysisExecutor.shutdown() }
    }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            val previewView = PreviewView(ctx)
            val cameraProviderFuture = ProcessCameraProvider.getInstance(ctx)
            cameraProviderFuture.addListener(
                {
                    val cameraProvider = cameraProviderFuture.get()
                    val preview = Preview.Builder().build().also {
                        it.surfaceProvider = previewView.surfaceProvider
                    }
                    val selector = ResolutionSelector.Builder()
                        .setResolutionStrategy(
                            ResolutionStrategy(
                                Size(1280, 720),
                                ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER,
                            ),
                        )
                        .build()
                    val analysis = ImageAnalysis.Builder()
                        .setResolutionSelector(selector)
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                    val scanner = BarcodeScanning.getClient()
                    analysis.setAnalyzer(analysisExecutor) { imageProxy ->
                        if (!enabledRef.get() || handled.get()) {
                            imageProxy.close()
                            return@setAnalyzer
                        }
                        val mediaImage = mediaImageOrNull(imageProxy)
                        if (mediaImage == null) {
                            imageProxy.close()
                            return@setAnalyzer
                        }
                        val image = InputImage.fromMediaImage(
                            mediaImage,
                            imageProxy.imageInfo.rotationDegrees,
                        )
                        scanner.process(image)
                            .addOnSuccessListener { barcodes ->
                                val raw = barcodes.firstOrNull {
                                    it.valueType == Barcode.TYPE_TEXT ||
                                        it.valueType == Barcode.TYPE_URL ||
                                        it.rawValue != null
                                }?.rawValue
                                if (raw != null && handled.compareAndSet(false, true)) {
                                    onBarcode(raw)
                                }
                            }
                            .addOnCompleteListener { imageProxy.close() }
                    }
                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(
                        lifecycleOwner,
                        CameraSelector.DEFAULT_BACK_CAMERA,
                        preview,
                        analysis,
                    )
                },
                ContextCompat.getMainExecutor(ctx),
            )
            previewView
        },
    )
}

@ExperimentalGetImage
private fun mediaImageOrNull(imageProxy: ImageProxy) = imageProxy.image
