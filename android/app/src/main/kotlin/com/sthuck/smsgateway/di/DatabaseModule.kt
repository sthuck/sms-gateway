package com.sthuck.smsgateway.di

import android.content.Context
import androidx.room.Room
import com.sthuck.smsgateway.data.local.AppDatabase
import com.sthuck.smsgateway.data.local.QueuedMessageDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun appDatabase(@ApplicationContext context: Context): AppDatabase =
        Room.databaseBuilder(context, AppDatabase::class.java, "sms-gateway.db")
            .fallbackToDestructiveMigration(dropAllTables = true)
            .build()

    @Provides
    fun queuedMessageDao(db: AppDatabase): QueuedMessageDao = db.queuedMessageDao()
}
