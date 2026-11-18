package com.sthuck.smsgateway.sms

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class SmsPermissionStore @Inject constructor(
    @ApplicationContext context: Context,
) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var hasRequested: Boolean
        get() = prefs.getBoolean(KEY_REQUESTED, false)
        set(value) {
            prefs.edit { putBoolean(KEY_REQUESTED, value) }
        }

    fun snapshot(activity: Activity): SmsPermissionSnapshot = SmsPermissionSnapshot(
        receiveGranted = granted(activity, Manifest.permission.RECEIVE_SMS),
        readGranted = granted(activity, Manifest.permission.READ_SMS),
        receiveShouldShowRationale = ActivityCompat.shouldShowRequestPermissionRationale(
            activity,
            Manifest.permission.RECEIVE_SMS,
        ),
        readShouldShowRationale = ActivityCompat.shouldShowRequestPermissionRationale(
            activity,
            Manifest.permission.READ_SMS,
        ),
        hasRequestedBefore = hasRequested,
    )

    fun areGranted(context: Context): Boolean =
        granted(context, Manifest.permission.RECEIVE_SMS) &&
            granted(context, Manifest.permission.READ_SMS)

    private fun granted(context: Context, permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private companion object {
        const val PREFS = "sms_permissions"
        const val KEY_REQUESTED = "requested"
    }
}
