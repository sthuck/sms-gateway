package com.sthuck.smsgateway.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.migration.Migration

/** Current Room schema version; must match `app/schemas/.../<n>.json`. */
const val APP_DATABASE_VERSION = 2

/**
 * Outbox database. Schema JSON is exported under `app/schemas/` and must
 * stay in source control so every bump can ship an explicit Migration /
 * AutoMigration (see STH-41). Do not enable destructive fallback on release.
 */
@Database(
    entities = [QueuedMessageEntity::class],
    version = APP_DATABASE_VERSION,
    exportSchema = true,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun queuedMessageDao(): QueuedMessageDao

    companion object {
        /** Explicit migrations for release builds. Append each schema bump here. */
        val MIGRATIONS: Array<Migration> = emptyArray()
    }
}
