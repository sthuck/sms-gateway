package com.sthuck.smsgateway.sms

import android.Manifest
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import com.sthuck.smsgateway.MainActivity
import com.sthuck.smsgateway.data.local.QueuedMessageDao
import com.sthuck.smsgateway.data.local.QueuedMessageEntity
import dagger.hilt.android.testing.HiltAndroidRule
import dagger.hilt.android.testing.HiltAndroidTest
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import java.io.FileInputStream
import javax.inject.Inject

/**
 * End-to-end receipt tests. They poll the Room outbox for a sender/body pair
 * that the host script injects with `adb emu sms send` after a short delay
 * (see `android/scripts/run-connected-dev-debug.sh`).
 *
 * The expected body includes a run token from the `debug.smsgateway.e2e_token`
 * system property so a cached AVD cannot satisfy the assertion with a leftover
 * message from a previous run.
 */
@HiltAndroidTest
@RunWith(AndroidJUnit4::class)
class IncomingSmsReceiptTest {

    private val hiltRule = HiltAndroidRule(this)
    private val permissionRule = GrantPermissionRule.grant(
        Manifest.permission.RECEIVE_SMS,
        Manifest.permission.READ_SMS,
    )
    private val activityRule = ActivityScenarioRule(MainActivity::class.java)

    @get:Rule
    val rules: RuleChain = RuleChain.outerRule(hiltRule)
        .around(permissionRule)
        .around(activityRule)

    @Inject
    lateinit var dao: QueuedMessageDao

    private lateinit var token: String

    @Before
    fun setUp() {
        hiltRule.inject()
        token = readSystemProperty(TOKEN_PROPERTY)
        if (token.isBlank()) {
            fail(
                "$TOKEN_PROPERTY is not set. Run these tests via " +
                    "android/scripts/run-connected-dev-debug.sh so the host can " +
                    "inject SMS with adb emu sms send.",
            )
        }
    }

    @Test
    fun receivesSingleSmsFromEmulatorConsole() = runBlocking {
        val expectedBody = "Your code is 123456 [$token]"
        val row = awaitQueuedMessage(SINGLE_SENDER, expectedBody)
        assertInboundShape(row)
        assertEquals(SINGLE_SENDER, row.sender)
        assertEquals(expectedBody, row.body)
    }

    @Test
    fun receivesMultipartSmsAsOneQueuedMessage() = runBlocking {
        val expectedBody = "${"A".repeat(200)}[$token]"
        assertTrue("fixture must exceed 160 GSM characters", expectedBody.length > 160)
        val row = awaitQueuedMessage(MULTIPART_SENDER, expectedBody)
        assertInboundShape(row)
        assertEquals(expectedBody, row.body)
        val copies = dao.getAll().count { it.sender == MULTIPART_SENDER && it.body == expectedBody }
        assertEquals("multipart PDU should be stored as a single outbox row", 1, copies)
    }

    private suspend fun awaitQueuedMessage(
        sender: String,
        body: String,
        timeoutMs: Long = 30_000,
    ): QueuedMessageEntity {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            dao.getAll().firstOrNull { it.sender == sender && it.body == body }?.let { return it }
            delay(500)
        }
        val seen = dao.getAll().joinToString(separator = "\n") { "${it.sender} len=${it.body.length}" }
        fail(
            "Timed out after ${timeoutMs}ms waiting for SMS from $sender " +
                "(expected body length ${body.length}). Queue was:\n$seen",
        )
        throw IllegalStateException("unreachable")
    }

    private fun assertInboundShape(row: QueuedMessageEntity) {
        assertEquals("inbound", row.direction)
        assertTrue(row.deviceMsgId.startsWith("sms-"))
        assertTrue(row.deviceMsgId.length <= 128)
        assertTrue(row.receivedAt.endsWith("Z"))
    }

    private fun readSystemProperty(name: String): String {
        val pfd = InstrumentationRegistry.getInstrumentation()
            .uiAutomation
            .executeShellCommand("getprop $name")
        return pfd.use { fd ->
            FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.trim()
        }
    }

    private companion object {
        const val TOKEN_PROPERTY = "debug.smsgateway.e2e_token"
        const val SINGLE_SENDER = "+15551234567"
        const val MULTIPART_SENDER = "+15559876543"
    }
}
