package com.sthuck.smsgateway.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import androidx.room.migration.Migration

/**
 * Outbox database. Schema JSON is exported under `app/schemas/` and must
 * stay in source control so every bump can ship an explicit Migration /
 * AutoMigration (see STH-41). Do not enable destructive fallback on release.
 */
@Database(
    entities = [QueuedMessageEntity::class],
    version = CURRENT_VERSION,
    exportSchema = true,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun queuedMessageDao(): QueuedMessageDao

    companion object {
        const val CURRENT_VERSION = 2

        /** Explicit migrations for release builds. Append each schema bump here. */
        val MIGRATIONS: Array<Migration> = emptyArray()
    }
}
