package com.sthuck.smsgateway.upload

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject

@HiltWorker
class MessageUploadWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val uploader: OutboxUploader,
    private val uploadScheduler: UploadScheduler,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        // Drain until idle, re-pair stop, or a retryable pause.
        var guard = 0
        while (guard++ < 32) {
            when (val pass = uploader.runOnce()) {
                is UploadPassResult.Idle, is UploadPassResult.NothingToDo -> {
                    return Result.success()
                }
                is UploadPassResult.MorePending -> {
                    // Continue draining in this worker invocation.
                    continue
                }
                is UploadPassResult.RetryLater -> {
                    return Result.retry()
                }
                is UploadPassResult.StopForRePair -> {
                    return Result.failure()
                }
                is UploadPassResult.Failed -> {
                    return Result.failure()
                }
            }
        }
        // Still pending after many batches — schedule another unique run.
        uploadScheduler.enqueueUpload()
        return Result.success()
    }
}
