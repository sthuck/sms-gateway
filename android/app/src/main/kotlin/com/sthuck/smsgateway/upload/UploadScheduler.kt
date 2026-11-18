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

@Singleton
class UploadScheduler @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    /**
     * Enqueue (or replace/append) the unique upload worker.
     *
     * Default [ExistingWorkPolicy.APPEND_OR_REPLACE] so an enqueue while a
     * drain is running is not dropped (KEEP would ignore it). Use a positive
     * [initialDelayMs] to wake after `nextAttemptAt` without a live process.
     */
    fun enqueueUpload(
        policy: ExistingWorkPolicy = ExistingWorkPolicy.APPEND_OR_REPLACE,
        initialDelayMs: Long = 0L,
    ) {
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
        val delay = initialDelayMs.coerceAtLeast(0L)
        if (delay > 0L) {
            // Expedited work cannot carry an initial delay.
            builder.setInitialDelay(delay, TimeUnit.MILLISECONDS)
        } else {
            builder.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
        }
        WorkManager.getInstance(context).enqueueUniqueWork(
            UploadDefaults.UNIQUE_WORK_NAME,
            policy,
            builder.build(),
        )
    }

    /** Schedule a unique drain at/after [nextAttemptAtEpochMs]. */
    fun enqueueDelayedUntil(nextAttemptAtEpochMs: Long) {
        val delay = (nextAttemptAtEpochMs - System.currentTimeMillis()).coerceAtLeast(0L)
        enqueueUpload(
            policy = ExistingWorkPolicy.APPEND_OR_REPLACE,
            initialDelayMs = delay,
        )
    }
}
