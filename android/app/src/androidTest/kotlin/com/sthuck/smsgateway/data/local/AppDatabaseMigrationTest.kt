package com.sthuck.smsgateway.data.local

import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Guards the outbox schema. When [AppDatabase] version bumps, add an
 * explicit Migration / AutoMigration and extend this test so release
 * builds never rely on destructive fallback (STH-41).
 */
@RunWith(AndroidJUnit4::class)
class AppDatabaseMigrationTest {

    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        AppDatabase::class.java,
        emptyList(),
        FrameworkSQLiteOpenHelperFactory(),
    )

    @Test
    fun exportedSchemaMatchesCurrentVersion() {
        // Creates DB at v2 from the committed schema JSON and validates it
        // against the entities Room would open today (no migrations yet).
        helper.createDatabase(TEST_DB, 2).close()
        helper.runMigrationsAndValidate(TEST_DB, 2, true)
    }

    companion object {
        private const val TEST_DB = "migration-test"
    }
}
