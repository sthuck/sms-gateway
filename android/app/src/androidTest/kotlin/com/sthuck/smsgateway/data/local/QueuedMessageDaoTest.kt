package com.sthuck.smsgateway.data.local

import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class QueuedMessageDaoTest {

    private lateinit var db: AppDatabase
    private lateinit var dao: QueuedMessageDao

    @Before
    fun setUp() {
        db = Room.inMemoryDatabaseBuilder(
            ApplicationProvider.getApplicationContext(),
            AppDatabase::class.java,
        ).build()
        dao = db.queuedMessageDao()
    }

    @After
    fun tearDown() {
        db.close()
    }

    @Test
    fun insertThenDuplicateDeviceMsgIdIsIgnored() = runBlocking {
        val original = QueuedMessageEntity(
            deviceMsgId = "sms-abc-0",
            contentKey = "abc",
            sender = "+15550001111",
            body = "first",
            receivedAt = "2026-11-18T09:45:12Z",
            direction = "inbound",
            simSlot = 0,
            createdAtEpochMs = 1L,
        )
        val duplicate = original.copy(
            sender = "+15559999999",
            body = "should not replace",
            createdAtEpochMs = 2L,
        )

        val firstRowId = dao.insert(original)
        val secondRowId = dao.insert(duplicate)

        assertTrue("first insert should succeed", firstRowId > 0)
        assertEquals("duplicate device_msg_id must be ignored", -1L, secondRowId)

        val rows = dao.getAll()
        assertEquals(1, rows.size)
        assertEquals("first", rows.single().body)
        assertEquals("+15550001111", rows.single().sender)
        assertEquals(1L, rows.single().createdAtEpochMs)
    }
}
