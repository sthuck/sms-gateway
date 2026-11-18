package com.sthuck.smsgateway.data.local

import androidx.room.testing.MigrationTestHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Guards the outbox schema. When [AppDatabase] version bumps, add an
 * explicit Migration to [AppDatabase.MIGRATIONS] and extend this test so
 * release builds never rely on destructive fallback (STH-41 / STH-13).
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
    fun migrateV2ToV3PreservesRowsAndAddsUploaderColumns() {
        helper.createDatabase(TEST_DB, 2).apply {
            execSQL(
                """
                INSERT INTO queued_messages
                (deviceMsgId, contentKey, sender, body, receivedAt, direction, simSlot, createdAtEpochMs)
                VALUES
                ('sms-abc-0', 'abc', '+15551234567', 'hello', '2026-11-18T09:45:12Z', 'inbound', 0, 1000)
                """.trimIndent(),
            )
            close()
        }

        val migrated = helper.runMigrationsAndValidate(
            TEST_DB,
            3,
            true,
            AppDatabase.MIGRATION_2_3,
        )
        migrated.query("SELECT deviceMsgId, body, attemptCount, nextAttemptAtEpochMs, lastError, parked FROM queued_messages")
            .use { cursor ->
                assertEquals(1, cursor.count)
                cursor.moveToFirst()
                assertEquals("sms-abc-0", cursor.getString(0))
                assertEquals("hello", cursor.getString(1))
                assertEquals(0, cursor.getInt(2))
                assertEquals(0L, cursor.getLong(3))
                assertNull(cursor.getString(4))
                assertEquals(0, cursor.getInt(5))
                assertFalse(cursor.isNull(2))
            }
        migrated.close()
    }

    @Test
    fun exportedSchemaMatchesCurrentVersion() {
        helper.createDatabase(TEST_DB_CURRENT, APP_DATABASE_VERSION).close()
        helper.runMigrationsAndValidate(
            TEST_DB_CURRENT,
            APP_DATABASE_VERSION,
            true,
            *AppDatabase.MIGRATIONS,
        )
    }

    companion object {
        private const val TEST_DB = "migration-test-v2-v3"
        private const val TEST_DB_CURRENT = "migration-test-current"
    }
}
