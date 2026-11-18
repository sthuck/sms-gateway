package com.sthuck.smsgateway.upload

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/** Testable surface for scheduling outbox drains. */
interface UploadWorkScheduler {
    fun enqueueUpload(
        policy: ExistingWorkPolicy? = null,
        initialDelayMs: Long = 0L,
    )

    fun enqueueDelayedUntil(nextAttemptAtEpochMs: Long)

    fun defaultPolicyForDelay(initialDelayMs: Long): ExistingWorkPolicy
}

@Singleton
class UploadScheduler @Inject constructor(
    @ApplicationContext private val context: Context,
) : UploadWorkScheduler {

    /**
     * Enqueue the unique upload worker.
     *
     * Default policy: [ExistingWorkPolicy.REPLACE] when [initialDelayMs] is 0
     * so a newly received SMS is not stuck behind a delayed backoff wake-up;
     * [ExistingWorkPolicy.APPEND_OR_REPLACE] when delaying (wake-up chain).
     * Callers may still pass an explicit [policy] (e.g. REPLACE after re-pair).
     */
    override fun enqueueUpload(
        policy: ExistingWorkPolicy?,
        initialDelayMs: Long,
    ) {
        val delay = initialDelayMs.coerceAtLeast(0L)
        val resolvedPolicy = policy ?: policyForDelay(delay)
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        val builder = OneTimeWorkRequestBuilder<MessageUploadWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                UploadDefaults.BACKOFF_INITIAL_SECONDS,
                TimeUnit.SECONDS,
            )
            .addTag(UploadDefaults.UNIQUE_WORK_NAME)
        if (delay > 0L) {
            // Expedited work cannot carry an initial delay.
            builder.setInitialDelay(delay, TimeUnit.MILLISECONDS)
        } else {
            builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        }
        WorkManager.getInstance(context).enqueueUniqueWork(
            UploadDefaults.UNIQUE_WORK_NAME,
            resolvedPolicy,
            builder.build(),
        )
    }

    /** Schedule a unique drain at/after [nextAttemptAtEpochMs] (append/delay only). */
    override fun enqueueDelayedUntil(nextAttemptAtEpochMs: Long) {
        val delay = (nextAttemptAtEpochMs - System.currentTimeMillis()).coerceAtLeast(0L)
        enqueueUpload(
            policy = ExistingWorkPolicy.APPEND_OR_REPLACE,
            initialDelayMs = delay,
        )
    }

    /** Policy chosen for a given delay when the caller does not override. */
    override fun defaultPolicyForDelay(initialDelayMs: Long): ExistingWorkPolicy =
        policyForDelay(initialDelayMs)

    companion object {
        fun policyForDelay(initialDelayMs: Long): ExistingWorkPolicy =
            if (initialDelayMs.coerceAtLeast(0L) == 0L) {
                ExistingWorkPolicy.REPLACE
            } else {
                ExistingWorkPolicy.APPEND_OR_REPLACE
            }
    }
}
