package com.sthuck.smsgateway.keepalive

/**
 * OEM battery / autostart setup targets for the onboarding checklist.
 * Deep links are best-effort; [OemSetupTarget.fallbackWebUrl] always works.
 */
data class OemSetupTarget(
    val vendorId: String,
    val displayName: String,
    /** Package/activity deep-link attempts, tried in order until one resolves. */
    val deepLinkUris: List<String>,
    val fallbackWebUrl: String,
)

object OemSetupCatalog {

    private val xiaomi = OemSetupTarget(
        vendorId = "xiaomi",
        displayName = "Xiaomi / Redmi / POCO",
        deepLinkUris = listOf(
            "intent:#Intent;component=com.miui.securitycenter/com.miui.permcenter.autostart.AutoStartManagementActivity;end",
            "intent:#Intent;component=com.miui.powerkeeper/.ui.HiddenAppsConfigActivity;end",
        ),
        fallbackWebUrl = "https://dontkillmyapp.com/xiaomi",
    )

    private val samsung = OemSetupTarget(
        vendorId = "samsung",
        displayName = "Samsung",
        deepLinkUris = listOf(
            "intent:#Intent;component=com.samsung.android.lool/com.samsung.android.sm.battery.ui.BatteryActivity;end",
            "intent:#Intent;component=com.samsung.android.sm/.ui.battery.BatteryActivity;end",
        ),
        fallbackWebUrl = "https://dontkillmyapp.com/samsung",
    )

    private val huawei = OemSetupTarget(
        vendorId = "huawei",
        displayName = "Huawei / Honor",
        deepLinkUris = listOf(
            "intent:#Intent;action=huawei.intent.action.HSM_PROTECTED_APPS;end",
            "intent:#Intent;component=com.huawei.systemmanager/.startupmgr.ui.StartupNormalAppListActivity;end",
        ),
        fallbackWebUrl = "https://dontkillmyapp.com/huawei",
    )

    private val oneplus = OemSetupTarget(
        vendorId = "oneplus",
        displayName = "OnePlus / Oppo",
        deepLinkUris = listOf(
            "intent:#Intent;component=com.oneplus.security/.chainlaunch.view.ChainLaunchAppListActivity;end",
            "intent:#Intent;component=com.oplus.battery/.BatteryMainActivity;end",
        ),
        fallbackWebUrl = "https://dontkillmyapp.com/oneplus",
    )

    private val generic = OemSetupTarget(
        vendorId = "generic",
        displayName = "Other phones",
        deepLinkUris = emptyList(),
        fallbackWebUrl = "https://dontkillmyapp.com/",
    )

    /** Known vendor rows shown on the checklist (OEM-specific first). */
    val knownVendors: List<OemSetupTarget> = listOf(xiaomi, samsung, huawei, oneplus)

    fun forManufacturer(manufacturer: String?): OemSetupTarget {
        val key = manufacturer.orEmpty().trim().lowercase()
        return when {
            key.isEmpty() -> generic
            key.contains("xiaomi") || key.contains("redmi") || key.contains("poco") -> xiaomi
            key.contains("samsung") -> samsung
            key.contains("huawei") || key.contains("honor") -> huawei
            key.contains("oneplus") || key.contains("oppo") || key.contains("realme") -> oneplus
            else -> generic.copy(
                displayName = manufacturer!!.trim().ifEmpty { generic.displayName },
                fallbackWebUrl = "https://dontkillmyapp.com/",
            )
        }
    }
}
