package com.sthuck.smsgateway.data.local

import androidx.room.Database
import androidx.room.RoomDatabase

@Database(
    entities = [QueuedMessageEntity::class],
    version = 2,
    exportSchema = false,
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun queuedMessageDao(): QueuedMessageDao
}
