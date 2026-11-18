package com.sthuck.smsgateway.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

/** Current Room schema version; must match `app/schemas/.../<n>.json`. */
const val APP_DATABASE_VERSION = 4

/**
 * Outbox database. Schema JSON is exported under `app/schemas/` and must
 * stay in source control so every bump can ship an explicit Migration /
 * AutoMigration (see STH-41). Do not enable destructive fallback on release.
 */
@Database(
    entities = [QueuedMessageEntity::class, ContentKeyCounterEntity::class],
    version = APP_DATABASE_VERSION,
    exportSchema = true,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun queuedMessageDao(): QueuedMessageDao

    companion object {
        /** Explicit migrations for release builds. Append each schema bump here. */
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "ALTER TABLE queued_messages ADD COLUMN attemptCount INTEGER NOT NULL DEFAULT 0",
                )
                db.execSQL(
                    "ALTER TABLE queued_messages ADD COLUMN nextAttemptAtEpochMs INTEGER NOT NULL DEFAULT 0",
                )
                db.execSQL(
                    "ALTER TABLE queued_messages ADD COLUMN lastError TEXT",
                )
                db.execSQL(
                    "ALTER TABLE queued_messages ADD COLUMN parked INTEGER NOT NULL DEFAULT 0",
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_queued_messages_parked_nextAttemptAtEpochMs` " +
                        "ON `queued_messages` (`parked`, `nextAttemptAtEpochMs`)",
                )
            }
        }

        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE TABLE IF NOT EXISTS `content_key_counters` " +
                        "(`contentKey` TEXT NOT NULL, `nextOrdinal` INTEGER NOT NULL, " +
                        "PRIMARY KEY(`contentKey`))",
                )
                // Seed counters from any rows still in the outbox so a later
                // identical SMS does not reuse an in-flight ordinal.
                db.execSQL(
                    """
                    INSERT INTO content_key_counters (contentKey, nextOrdinal)
                    SELECT contentKey, COUNT(*) FROM queued_messages GROUP BY contentKey
                    """.trimIndent(),
                )
            }
        }

        val MIGRATIONS: Array<Migration> = arrayOf(MIGRATION_2_3, MIGRATION_3_4)
    }
}
