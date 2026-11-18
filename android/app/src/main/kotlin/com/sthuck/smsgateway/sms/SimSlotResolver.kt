package com.sthuck.smsgateway.sms

import android.content.Intent
import android.os.Build
import android.telephony.SubscriptionManager
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Resolves the zero-based SIM slot for an `SMS_RECEIVED` intent.
 *
 * Prefers an explicit slot extra, then maps the `subscription` extra through
 * [SubscriptionManager.getSlotIndex] (API 29+). Returns null when the slot
 * is unknown or -1.
 *
 * On API 26–28, if the intent has no slot extra, `sim_slot` is null. This
 * app does not request `READ_PHONE_STATE`, which would be required to look
 * up [android.telephony.SubscriptionInfo.simSlotIndex] on those versions.
 */
@Singleton
class SimSlotResolver @Inject constructor() {
    fun resolve(intent: Intent): Int? {
        for (name in SLOT_EXTRAS) {
            if (!intent.hasExtra(name)) continue
            IncomingSmsMapper.mapSimSlot(intent.getIntExtra(name, -1))?.let { return it }
        }

        val subId = subscriptionId(intent)
        if (subId == null || subId < 0 || subId == SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
            return null
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return IncomingSmsMapper.mapSimSlot(SubscriptionManager.getSlotIndex(subId))
        }
        return null
    }

    private fun subscriptionId(intent: Intent): Int? {
        for (name in SUBSCRIPTION_EXTRAS) {
            if (intent.hasExtra(name)) return intent.getIntExtra(name, -1)
        }
        return null
    }

    private companion object {
        // Literal names so minSdk 26 does not trip InlinedApi on API 30 constants.
        val SLOT_EXTRAS = listOf(
            "android.telephony.extra.SLOT_INDEX",
            "slot",
        )
        val SUBSCRIPTION_EXTRAS = listOf(
            "subscription",
            "android.telephony.extra.SUBSCRIPTION_INDEX",
        )
    }
}
