package com.sthuck.smsgateway.upload

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.sthuck.smsgateway.data.local.QueuedMessageDao
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject

@HiltWorker
class MessageUploadWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val uploader: OutboxUploader,
    private val uploadScheduler: UploadScheduler,
    private val queuedMessageDao: QueuedMessageDao,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        // Drain until idle, re-pair stop, or a retryable pause.
        var guard = 0
        while (guard++ < 32) {
            when (val pass = uploader.runOnce()) {
                is UploadPassResult.Idle, is UploadPassResult.NothingToDo -> {
                    scheduleIfPendingNotDue()
                    return Result.success()
                }
                is UploadPassResult.MorePending -> {
                    // Continue draining in this worker invocation.
                    continue
                }
                is UploadPassResult.RetryLater -> {
                    // Persist nextAttemptAt in Room; wake via delayed unique work
                    // so retries survive without a live process (M1 / STH-49).
                    scheduleIfPendingNotDue()
                    return Result.success()
                }
                is UploadPassResult.StopForRePair -> {
                    return Result.failure()
                }
                is UploadPassResult.Failed -> {
                    return Result.failure()
                }
            }
        }
        // Still pending after many batches — chain another unique run.
        uploadScheduler.enqueueUpload()
        return Result.success()
    }

    private suspend fun scheduleIfPendingNotDue() {
        val next = queuedMessageDao.earliestPendingAttemptAtEpochMs() ?: return
        val now = System.currentTimeMillis()
        if (next > now) {
            uploadScheduler.enqueueDelayedUntil(next)
        } else {
            // Ready rows remain (e.g. raced with insert) — run ASAP.
            uploadScheduler.enqueueUpload()
        }
    }
}
