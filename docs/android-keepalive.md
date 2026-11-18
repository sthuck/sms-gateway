# Android keepalive (STH-47)

## Recommendation

Use a **persistent foreground service (`specialUse`)** plus the existing **WorkManager** outbox drain. Do not rely on WorkManager alone.

| Option | Near-real-time upload | Survives OEM killers | Android 14/15 rules | User cost |
| --- | --- | --- | --- | --- |
| WorkManager alone | Poor under Doze / App Standby | Weak on Xiaomi/Samsung/Huawei/OnePlus | Fine | None |
| FGS `dataSync` + WorkManager | Good while the service runs | Better | Android 15 caps `dataSync` runtime; needs a restart strategy | Ongoing notification |
| **FGS `specialUse` + WorkManager (chosen)** | Good while the service runs | Best fit for a private sideloaded gateway | Declare `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`; Play would review the reason | Ongoing notification |

**Why `specialUse`:** this app’s job is continuous private SMS forwarding, not a short sync burst. Android 15’s `dataSync` time limit would force artificial stop/restart loops. The special-use subtype string documents that intent for the system (and for any future Play review).

WorkManager remains the upload transport: network constraints, backoff, and drains that survive without a live process. The FGS keeps the process warmer so `SMS_RECEIVED` → Room enqueue → expedited unique work stays prompt.

## SMS capture after death, reboot, Doze, force-stop

| Event | `SMS_RECEIVED` (manifest receiver) | Upload |
| --- | --- | --- |
| Process death | Delivered; process may be started for the receiver | Room enqueue + WorkManager; FGS may be blocked from starting in the background on API 31+ |
| Reboot (user unlocked) | Delivered after unlock | `BootUploadReceiver` on `BOOT_COMPLETED` re-enqueues WorkManager and starts the FGS |
| Doze | High-priority SMS broadcasts still delivered | WorkManager may delay; FGS + battery exemption reduce delay |
| **Force-stop** | **Blocked** until the user launches the app again | Same; no broadcast or FGS until next manual start |

Force-stop is a hard platform limit. Document it in onboarding; the app cannot work around it.

## Boot and credential-encrypted storage

`BootUploadReceiver` is **not** `directBootAware` and listens only for `BOOT_COMPLETED` (after the user unlocks). Room, DataStore, and WorkManager use credential-encrypted storage, which is unavailable at locked boot. Do not touch CE storage from a locked-boot path. Locked-boot / `LOCKED_BOOT_COMPLETED` is intentionally out of scope.

## Permissions

| Permission | Why |
| --- | --- |
| `RECEIVE_SMS` / `READ_SMS` | Capture (existing) |
| `RECEIVE_BOOT_COMPLETED` | Reschedule uploads + restart FGS after unlock |
| `FOREGROUND_SERVICE` | Start the keepalive service |
| `FOREGROUND_SERVICE_SPECIAL_USE` | Android 14+ FGS type |
| `POST_NOTIFICATIONS` | Ongoing FGS notification (API 33+) |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | Ask for exemption (sideloaded; Play would restrict this) |
| `INTERNET` | Upload / optional heartbeat |

## User-facing setup

After pairing, the status screen shows a **background setup** checklist:

1. Allow notifications (required for the FGS on API 33+).
2. Exempt the app from battery optimisation (`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`).
3. Open phone-maker autostart / battery pages when the manufacturer is Xiaomi, Samsung, Huawei, or OnePlus; otherwise open a dontkillmyapp-style fallback page for that vendor.
4. Understand force-stop: if the user force-stops the app, SMS capture stops until they open it again.

## Heartbeat

Client support for `POST /v1/devices/me/heartbeat` is implemented behind `BuildConfig.HEARTBEAT_ENABLED` (**default `false`**). The backend endpoint is not shipped yet; see `docs/contracts/device-heartbeat-draft.md`. When enabled, failures (including 404/5xx) are ignored and **never** park or delay outbox uploads.

## What needs a real device

Emulator unit/instrumented checks cover wiring and pure policy. Confirm on hardware (especially OEM skins): FGS start after boot, battery-exemption UX, manufacturer deep links, Doze upload latency, and behaviour after force-stop then relaunch.
