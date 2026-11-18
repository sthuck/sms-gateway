package com.sthuck.smsgateway.keepalive

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri

/**
 * Resolves the first OEM deep link that the package manager can handle,
 * otherwise opens the dontkillmyapp-style fallback URL.
 */
object OemSetupLauncher {
    fun intentFor(context: Context, target: OemSetupTarget): Intent {
        val pm = context.packageManager
        for (uri in target.deepLinkUris) {
            val parsed = runCatching { Intent.parseUri(uri, Intent.URI_INTENT_SCHEME) }.getOrNull()
                ?: continue
            parsed.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (parsed.resolveActivity(pm) != null) {
                return parsed
            }
        }
        return Intent(Intent.ACTION_VIEW, Uri.parse(target.fallbackWebUrl)).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    fun canResolveDeepLink(pm: PackageManager, target: OemSetupTarget): Boolean =
        target.deepLinkUris.any { uri ->
            val parsed = runCatching { Intent.parseUri(uri, Intent.URI_INTENT_SCHEME) }.getOrNull()
                ?: return@any false
            parsed.resolveActivity(pm) != null
        }
}
