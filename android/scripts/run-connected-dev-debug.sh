#!/usr/bin/env bash
# Runs connectedDevDebugAndroidTest against a booted emulator and injects
# SMS from the host via `adb emu sms send` while the tests poll the outbox.
# Pulls UiScreenshotTest PNGs afterward (that class is part of the connected
# suite) so CI always uploads app/build/screenshots.
#
# Used by the GitHub Actions `instrumented` job. Locally, start an emulator
# first, then run this script from android/ (or any cwd; it cds itself).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PACKAGE="com.sthuck.smsgateway.dev"
SINGLE_SENDER="+15551234567"
MULTIPART_SENDER="+15559876543"
TOKEN="${SMS_E2E_TOKEN:-${GITHUB_RUN_ID:-local}-$(date +%s)}"
WAIT_TIMEOUT_SECONDS="${SMS_E2E_WAIT_TIMEOUT_SEC:-240}"
SCREENSHOT_HOST="$ROOT/app/build/screenshots"
SCREENSHOT_DEVICE_APP="/sdcard/Android/data/${PACKAGE}/files/sms-gateway-screenshots"
SCREENSHOT_DEVICE_DL="/sdcard/Download/sms-gateway-screenshots"

log() { echo "[sms-e2e] $*"; }

capture_logs() {
  mkdir -p "$ROOT/app/build/reports"
  adb logcat -d > "$ROOT/app/build/reports/logcat-connected.txt" 2>/dev/null || true
}

trap capture_logs EXIT

wait_until() {
  local description="$1"
  shift
  until "$@"; do
    if (( SECONDS >= DEADLINE )); then
      log "Timed out waiting for: $description" >&2
      return 1
    fi
    sleep 2
  done
}

package_installed() {
  adb shell pm path "$PACKAGE" >/dev/null 2>&1
}

app_process_running() {
  adb shell pidof "$PACKAGE" >/dev/null 2>&1
}

# True when $PACKAGE has stayed alive across several checks. Gradle's
# connected install force-stops the app; sending SMS in that window drops
# broadcasts (especially multipart).
process_stable() {
  local hits=0
  while (( hits < 3 )); do
    if ! app_process_running; then
      return 1
    fi
    hits=$((hits + 1))
    sleep 2
  done
  return 0
}

send_sms_when_ready() {
  wait_until "$PACKAGE is installed" package_installed
  log "Granting SMS permissions to $PACKAGE"
  adb shell pm grant "$PACKAGE" android.permission.RECEIVE_SMS
  adb shell pm grant "$PACKAGE" android.permission.READ_SMS

  wait_until "$PACKAGE process is stable (post-install)" process_stable
  # Do NOT `am start MainActivity` here: IncomingSmsReceiptTest already
  # launches it via ActivityScenarioRule, and a host-started instance leaves
  # the activity PAUSED so scenario.close() never reaches DESTROYED.
  # Instrumentation itself clears the package "stopped" state.
  #
  # Let IncomingSmsReceiptTest reach its poll loop (it runs after a few
  # faster suites under connectedDevDebugAndroidTest).
  sleep 5

  local long_body
  long_body="$(python3 -c 'print("A" * 200)')"
  log "Sending single SMS to $SINGLE_SENDER (token=$TOKEN)"
  adb emu sms send "$SINGLE_SENDER" "Your code is 123456 [$TOKEN]"
  sleep 2
  log "Sending multipart SMS to $MULTIPART_SENDER (>160 chars)"
  adb emu sms send "$MULTIPART_SENDER" "${long_body}[$TOKEN]"
}

pull_screenshots() {
  mkdir -p "$SCREENSHOT_HOST"
  log "Pulling screenshots from $SCREENSHOT_DEVICE_APP and $SCREENSHOT_DEVICE_DL"
  adb pull "$SCREENSHOT_DEVICE_APP/." "$SCREENSHOT_HOST/" 2>/dev/null || true
  adb pull "$SCREENSHOT_DEVICE_DL/." "$SCREENSHOT_HOST/" 2>/dev/null || true
  find "$SCREENSHOT_HOST" -type f -name '*.png' | sort
  ls -la "$SCREENSHOT_HOST" || true
}

png_count() {
  find "$SCREENSHOT_HOST" -type f -name '*.png' 2>/dev/null | wc -l | tr -d ' '
}

log "E2E token: $TOKEN"
# Pre-build APKs before starting the wait deadline so Gradle compilation
# never consumes the SMS injector's post-install timeout budget.
log "Pre-building devDebug and androidTest APKs"
./gradlew assembleDevDebug assembleDevDebugAndroidTest --stacktrace

adb wait-for-device
adb shell setprop debug.smsgateway.e2e_token "$TOKEN"

DEADLINE=$((SECONDS + WAIT_TIMEOUT_SECONDS))
# SMS injection must run against the install used by connectedDevDebugAndroidTest.
# Do not install/run a separate am-instrument pass beforehand — that races
# Gradle's reinstall and drops the injected SMS (multipart especially).
send_sms_when_ready &
SENDER_PID=$!

set +e
./gradlew connectedDevDebugAndroidTest --stacktrace
GRADLE_RC=$?
set -e

# Don't leave a stuck sender if gradle failed early.
wait "$SENDER_PID" || true

pull_screenshots || true
count="$(png_count)"
if (( count < 4 )); then
  log "Expected at least 4 PNGs under $SCREENSHOT_HOST, found $count" >&2
  exit 1
fi

exit "$GRADLE_RC"
