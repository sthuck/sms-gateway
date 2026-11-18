# SMS Gateway — Android

Kotlin / Jetpack Compose app that reads incoming SMS and will forward it to the
SMS Gateway backend. This tree includes the STH-7 skeleton and the STH-10 SMS
permission flow, incoming receiver, and local outbox.

The Gradle project root is this `android/` directory, so it can sit in the
`sms-gateway` monorepo with path-filtered CI.

## Prerequisites

- JDK 17
- Android SDK with platform 37.2 and Build-Tools 36.0.0 (AGP 9.5 + current Compose BOM need API 37; platform 35 is enough only if you pin an older BOM)
- Point `android/local.properties` at your SDK, or set `ANDROID_HOME`
- An Android emulator (API 26+). Physical devices are not required for this
  skeleton.

```bash
cd android
./gradlew assembleDevDebug lintDevDebug testDevDebugUnitTest
```

The dev debug APK is written to:

`app/build/outputs/apk/dev/debug/app-dev-debug.apk`

Install on an emulator:

```bash
./gradlew installDevDebug
```

## Flavours

| Flavour | `applicationId` | Default `BuildConfig.BACKEND_URL` |
| --- | --- | --- |
| `dev` (default) | `com.sthuck.smsgateway.dev` | `http://10.0.2.2:4010` |
| `prod` | `com.sthuck.smsgateway` | `https://sms.sthuck.info` (HTTPS only) |

Override a URL at build time without editing source:

```bash
./gradlew assembleDevDebug -PdevBackendUrl=http://10.0.2.2:4010
./gradlew assembleProdRelease -PprodBackendUrl=https://sms.sthuck.info
```

`dev` ships a network security config that allows cleartext HTTP only to
`10.0.2.2`, `localhost`, and `127.0.0.1`. `prod` explicitly forbids
cleartext.

## Architecture

Single-activity Compose app (`MainActivity`). Unpaired devices land on the
pairing screen (QR via CameraX + ML Kit, manual short code, or
`smsgw://pair?code=…&server=…` deep link). After pairing, the status screen
shows SMS permission state, queue depth, and an unpair action. Hilt wires the
graph. OkHttp rewrites the backend base URL from stored credentials (flavour
default until a QR/`server` override) and signs every device request per
STH-5. Incoming SMS is written to a Room outbox; the WorkManager uploader is
a later ticket (STH-13) and is not implemented yet.

Package: `com.sthuck.smsgateway`

- `pairing` — URI parse, DataStore credentials, pair/unpair repository
- `crypto` — Android Keystore ES256 (P-256) key, canonical string, clock skew
- `sms` — permission state, `SmsReceiver`, PDU reassembly, `device_msg_id` mapping
- `data/remote` — `DeviceApi`, signing interceptor, backend URL interceptor
- `data/local` — Room outbox (`queued_messages`) and enqueue helper.
  Schema JSON is exported to `app/schemas/` (committed). Release builds
  never use destructive migration; bump `AppDatabase` version only with
  an explicit Migration / AutoMigration and a `MigrationTestHelper` case.
- `di` — Hilt modules for network and database
- `ui` — pairing screen, status screen, permission rationale, and theme

Signing matches `docs/contracts/device-signing.md` and is unit-tested against
`docs/contracts/examples/test-vector.json` (including `devHostVector`).
Keystore generation is covered by an instrumented test.

### Incoming SMS and `device_msg_id`

`SmsReceiver` listens for `android.provider.Telephony.SMS_RECEIVED` (manifest
registration, `android:exported="true"`, permission `BROADCAST_SMS`). It
reassembles multipart PDUs with `Telephony.Sms.Intents.getMessagesFromIntent`,
concatenates parts that share an originating address, and uses the first part's
SMSC timestamp. The receiver only writes to Room (`goAsync()` + `Dispatchers.IO`);
it does not call the network. Outgoing SMS is not captured.

Each queued row uses the STH-5 message shape: `device_msg_id`, `sender` (E.164
or raw alphanumeric, leading `+` kept), `body`, `received_at` (UTC ISO 8601
with `Z`), `sim_slot` (zero-based, or null if unknown), `direction=inbound`.

`device_msg_id` is `sms-{contentKey}-{ordinal}`:

- `contentKey` is the first 32 lowercase hex characters of SHA-256 over a
  length-prefixed encoding of `(direction, sender, SMSC timestamp in seconds,
  body)`. Length-prefixing avoids collisions when a body or sender contains
  delimiters.
- `ordinal` is 0-based among messages that share that content key (genuine
  identical SMS in the same SMSC second). The live receiver uses the number of
  matching rows already in the queue. A later inbox backfill should group by
  the same key, sort by provider `_id` ascending, and assign 0, 1, 2… so the
  id is stable across restarts and matches a subsequent backfill. See KDoc on
  `IncomingSmsMapper`.

## Mock backend

The source of truth is **`docs/contracts/device-api.yaml`** (STH-5 v1 draft 2).
Do not keep a second copy under `android/`. Preferred local mock (Docker):

```bash
# from repo root — see docs/local-dev.md
docker compose --profile mock up mock-api
# → http://localhost:4010  (emulator: http://10.0.2.2:4010)
```

Or Prism via npx (same contract, Node.js required):

```bash
cd android/mock-backend
./run-mock.sh
# equivalent:
# npx --yes @stoplight/prism-cli mock -h 0.0.0.0 -p 4010 \
#   ../../docs/contracts/device-api.yaml
```

Prism listens on `http://127.0.0.1:4010`. The Android emulator reaches the
host loopback at **`10.0.2.2`**, which is why the `dev` flavour defaults to
`http://10.0.2.2:4010`. Do not use `127.0.0.1` inside the emulator — that is
the emulator itself, not your laptop.

Prism validates request **shape** only; it does not verify ES256 signatures
(see `docs/local-dev.md`). Instrumented and unit tests can also use the small
`DeviceApiMock` helper (MockWebServer) in `app/src/sharedTest/`. It serves the
same example payloads and `application/problem+json` errors as the spec.


## Testing incoming SMS on the emulator

Install the dev build, open the app, and grant **Receive SMS** and **Read SMS**
(or grant them from the shell). The status screen shows the permission state
and will update if you later revoke access in system settings (it re-checks
on resume).

```bash
./gradlew installDevDebug
adb shell pm grant com.sthuck.smsgateway.dev android.permission.RECEIVE_SMS
adb shell pm grant com.sthuck.smsgateway.dev android.permission.READ_SMS
```

Inject a message into the running emulator (keep the `+` if you want to
assert E.164 forwarding):

```bash
adb emu sms send +15551234567 "Your code is 123456"
```

A message longer than 160 GSM characters is delivered as a concatenated
multipart SMS. The receiver should enqueue **one** row whose body is the
full text:

```bash
adb emu sms send +15551234567 "$(python3 -c 'print("A"*200)')"
```

`adb emu` only works against an emulator, not a physical device. If more
than one device is connected, set `$ANDROID_SERIAL` or pass `-s emulator-5554`.

### Checking the queue

The status screen lists the pending count and the most recent ids, senders,
timestamps, and slot index (bodies are not shown). After a test SMS, that
list should gain a row without talking to the mock backend.

To inspect the database from the host:

```bash
adb exec-out run-as com.sthuck.smsgateway.dev   cat databases/sms-gateway.db > /tmp/sms-gateway.db
sqlite3 /tmp/sms-gateway.db   "SELECT deviceMsgId, sender, receivedAt, simSlot, length(body) FROM queued_messages;"
```

Sending the same text twice in the same SMSC second produces ids that share a
content key and differ by ordinal (`…-0`, `…-1`). Sending it again after a
restart keeps using the next free ordinal already stored in the queue.

## Instrumented tests and CI

`.github/workflows/android-ci.yml` (monorepo root) runs when `android/**` or
the workflow file changes.

- `build` compiles `assembleDevDebug`, runs `lintDevDebug` and
  `testDevDebugUnitTest`, and uploads the dev debug APK.
- `instrumented` (needs `build`) boots an API 34 `google_apis` x86_64
  emulator on `ubuntu-latest` (KVM udev rule + AVD cache) and runs
  `scripts/run-connected-dev-debug.sh`.

The connected-test script is the reliable way to inject SMS: `adb emu sms
send` only works from the **host** talking to the emulator console, not from
inside the app process. The flow is:

1. The script writes a unique token to `debug.smsgateway.e2e_token` and
   starts `./gradlew connectedDevDebugAndroidTest`.
2. In the background it waits until `com.sthuck.smsgateway.dev` is
   installed, grants `RECEIVE_SMS` and `READ_SMS`, starts `MainActivity`
   (so the app is not in the stopped state), then after a short delay
   sends two messages:
   - `adb emu sms send +15551234567 "Your code is 123456 [$token]"`
   - a 200-character body (`A` × 200 plus the token) to `+15559876543`,
     which the emulator delivers as concatenated multipart SMS.
3. `IncomingSmsReceiptTest` polls the Room outbox for up to 30 seconds
   for those exact sender/body pairs (the token avoids false passes from
   a cached AVD). The multipart case asserts **one** row with the full
   body. `QueuedMessageDaoTest` covers insert + ignored duplicate
   `device_msg_id` on an in-memory database and does not need a real SMS.

`GrantPermissionRule` also grants the two SMS permissions inside the
tests, as a second line of defence.

To run the same suite locally, start an emulator, then:

```bash
cd android
./scripts/run-connected-dev-debug.sh
```

Do not call `./gradlew connectedDevDebugAndroidTest` alone for the receipt
tests — they fail fast if the e2e token property is missing.
