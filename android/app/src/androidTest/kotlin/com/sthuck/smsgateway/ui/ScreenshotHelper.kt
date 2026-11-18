package com.sthuck.smsgateway.ui

import android.graphics.Bitmap
import android.os.Environment
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.captureToImage
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.FileOutputStream

/**
 * Writes Compose screenshots where CI can pull them without root:
 * 1. App external files: `/sdcard/Android/data/<package>/files/sms-gateway-screenshots/`
 * 2. Public Downloads mirror: `/sdcard/Download/sms-gateway-screenshots/`
 */
object ScreenshotHelper {
    const val DIR_NAME = "sms-gateway-screenshots"

    fun capture(node: SemanticsNodeInteraction, name: String): File {
        val bitmap = node.captureToImage().asAndroidBitmap()
        val primary = write(bitmap, File(externalFilesDir(), "$name.png"))
        // Best-effort mirror for flaky adb pull of app-specific external storage.
        runCatching {
            write(bitmap, File(publicDownloadDir(), "$name.png"))
        }
        return primary
    }

    private fun write(bitmap: Bitmap, out: File): File {
        out.parentFile?.mkdirs()
        FileOutputStream(out).use { stream ->
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) {
                "Failed to compress screenshot ${out.name}"
            }
        }
        check(out.exists() && out.length() > 0L) { "Screenshot not written: ${out.absolutePath}" }
        return out
    }

    private fun targetContext() =
        InstrumentationRegistry.getInstrumentation().targetContext

    private fun externalFilesDir(): File =
        File(targetContext().getExternalFilesDir(null), DIR_NAME).also { it.mkdirs() }

    private fun publicDownloadDir(): File {
        val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        return File(downloads, DIR_NAME).also { it.mkdirs() }
    }
}
