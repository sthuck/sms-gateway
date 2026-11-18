#!/usr/bin/env bash
# Runs connectedDevDebugAndroidTest against a booted emulator and injects
# SMS from the host via `adb emu sms send` while the tests poll the outbox.
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
DEADLINE=$((SECONDS + 240))

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

send_sms_when_ready() {
  wait_until "$PACKAGE is installed" package_installed
  log "Granting SMS permissions to $PACKAGE"
  adb shell pm grant "$PACKAGE" android.permission.RECEIVE_SMS
  adb shell pm grant "$PACKAGE" android.permission.READ_SMS
  # Leave the "stopped" state so the manifest receiver can run.
  adb shell am start -W -n "$PACKAGE/com.sthuck.smsgateway.MainActivity" >/dev/null 2>&1 || true

  wait_until "$PACKAGE process is running" app_process_running
  # Let the instrumented test reach its poll loop.
  sleep 5

  local long_body
  long_body="$(python3 -c 'print("A" * 200)')"
  log "Sending single SMS to $SINGLE_SENDER (token=$TOKEN)"
  adb emu sms send "$SINGLE_SENDER" "Your code is 123456 [$TOKEN]"
  sleep 2
  log "Sending multipart SMS to $MULTIPART_SENDER (>160 chars)"
  adb emu sms send "$MULTIPART_SENDER" "${long_body}[$TOKEN]"
}

log "E2E token: $TOKEN"
adb wait-for-device
adb shell setprop debug.smsgateway.e2e_token "$TOKEN"

send_sms_when_ready &
SENDER_PID=$!

set +e
./gradlew connectedDevDebugAndroidTest --stacktrace
GRADLE_RC=$?
set -e

# Don't leave a stuck sender if gradle failed early.
wait "$SENDER_PID" || true

# Pull Compose UI screenshots written by UiScreenshotTest (best-effort).
SCREENSHOT_HOST="$ROOT/app/build/screenshots"
SCREENSHOT_DEVICE="/sdcard/Android/data/${PACKAGE}/files/sms-gateway-screenshots"
mkdir -p "$SCREENSHOT_HOST"
log "Pulling screenshots from $SCREENSHOT_DEVICE -> $SCREENSHOT_HOST"
adb pull "$SCREENSHOT_DEVICE/." "$SCREENSHOT_HOST/" 2>/dev/null || \
  log "No screenshots found on device (tests may have skipped UI capture)."
ls -la "$SCREENSHOT_HOST" || true

exit "$GRADLE_RC"
