package com.sthuck.smsgateway.keepalive

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OemSetupCatalogTest {

    @Test
    fun mapsXiaomiFamily() {
        assertEquals("xiaomi", OemSetupCatalog.forManufacturer("Xiaomi").vendorId)
        assertEquals("xiaomi", OemSetupCatalog.forManufacturer("Redmi").vendorId)
        assertEquals("xiaomi", OemSetupCatalog.forManufacturer("POCO").vendorId)
    }

    @Test
    fun mapsSamsungHuaweiOnePlus() {
        assertEquals("samsung", OemSetupCatalog.forManufacturer("samsung").vendorId)
        assertEquals("huawei", OemSetupCatalog.forManufacturer("HUAWEI").vendorId)
        assertEquals("huawei", OemSetupCatalog.forManufacturer("Honor").vendorId)
        assertEquals("oneplus", OemSetupCatalog.forManufacturer("OnePlus").vendorId)
        assertEquals("oneplus", OemSetupCatalog.forManufacturer("OPPO").vendorId)
    }

    @Test
    fun unknownFallsBackToDontKillMyApp() {
        val target = OemSetupCatalog.forManufacturer("Google")
        assertEquals("generic", target.vendorId)
        assertTrue(target.deepLinkUris.isEmpty())
        assertEquals("https://dontkillmyapp.com/", target.fallbackWebUrl)
    }

    @Test
    fun knownVendorsExposeDeepLinksAndFallback() {
        OemSetupCatalog.knownVendors.forEach { vendor ->
            assertTrue(vendor.deepLinkUris.isNotEmpty())
            assertTrue(vendor.fallbackWebUrl.startsWith("https://dontkillmyapp.com/"))
        }
    }
}
