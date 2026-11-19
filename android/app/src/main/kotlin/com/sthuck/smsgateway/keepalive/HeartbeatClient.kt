package com.sthuck.smsgateway.keepalive

import com.sthuck.smsgateway.BuildConfig
import com.sthuck.smsgateway.data.remote.DeviceApi
import okhttp3.RequestBody.Companion.toRequestBody
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Signed device heartbeat. Isolated from the outbox uploader: every failure
 * is swallowed into a [HeartbeatOutcome] and must never park uploads.
 */
@Singleton
class HeartbeatClient @Inject constructor(
    private val deviceApi: DeviceApi,
) {
    val enabled: Boolean get() = BuildConfig.HEARTBEAT_ENABLED

    /**
     * @param enabledOverride test seam; production callers omit it so
     * [BuildConfig.HEARTBEAT_ENABLED] applies.
     */
    suspend fun send(enabledOverride: Boolean? = null): HeartbeatOutcome {
        if (!(enabledOverride ?: enabled)) return HeartbeatOutcome.Disabled
        return try {
            val response = deviceApi.postHeartbeat(EMPTY_BODY)
            HeartbeatPolicy.fromHttpCode(response.code())
        } catch (e: HttpException) {
            HeartbeatPolicy.fromHttpCode(e.code())
        } catch (_: IOException) {
            HeartbeatOutcome.RetryableIgnored
        } catch (_: Exception) {
            // Signing / unexpected — still never block uploads.
            HeartbeatOutcome.RetryableIgnored
        }
    }

    private companion object {
        val EMPTY_BODY = ByteArray(0).toRequestBody(null)
    }
}
