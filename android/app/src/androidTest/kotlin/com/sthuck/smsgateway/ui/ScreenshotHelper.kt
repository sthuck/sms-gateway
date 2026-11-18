package com.sthuck.smsgateway.ui

import android.content.Context
import android.graphics.Bitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.captureToImage
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.io.FileOutputStream

/**
 * Writes Compose screenshots to the app's external files dir so CI can
 * `adb pull` them without root:
 * `/sdcard/Android/data/<package>/files/sms-gateway-screenshots/`.
 */
object ScreenshotHelper {
    const val DIR_NAME = "sms-gateway-screenshots"

    fun dir(context: Context = targetContext()): File =
        File(context.getExternalFilesDir(null), DIR_NAME).also { it.mkdirs() }

    fun capture(node: SemanticsNodeInteraction, name: String): File {
        val bitmap = node.captureToImage().asAndroidBitmap()
        val out = File(dir(), "$name.png")
        FileOutputStream(out).use { stream ->
            check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)) {
                "Failed to compress screenshot $name"
            }
        }
        return out
    }

    fun targetContext(): Context =
        InstrumentationRegistry.getInstrumentation().targetContext

    /** Absolute device path used by the CI pull step. */
    fun devicePath(): String = dir().absolutePath
}
