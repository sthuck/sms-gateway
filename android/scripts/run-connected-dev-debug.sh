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

# Pull Compose UI screenshots written by UiScreenshotTest.
SCREENSHOT_HOST="$ROOT/app/build/screenshots"
SCREENSHOT_DEVICE_APP="/sdcard/Android/data/${PACKAGE}/files/sms-gateway-screenshots"
SCREENSHOT_DEVICE_DL="/sdcard/Download/sms-gateway-screenshots"
mkdir -p "$SCREENSHOT_HOST"

# Re-run screenshot tests explicitly so a quiet/empty connected suite cannot
# skip UI capture while still reporting BUILD SUCCESSFUL.
if (( GRADLE_RC == 0 )); then
  log "Re-running UiScreenshotTest via am instrument"
  adb shell am instrument -w \
    -e class com.sthuck.smsgateway.ui.UiScreenshotTest \
    "${PACKAGE}.test/dagger.hilt.android.testing.HiltTestRunner" \
    | tee "$ROOT/app/build/reports/ui-screenshot-instrument.txt"
fi

log "Pulling screenshots from $SCREENSHOT_DEVICE_APP and $SCREENSHOT_DEVICE_DL"
adb pull "$SCREENSHOT_DEVICE_APP/." "$SCREENSHOT_HOST/" 2>/dev/null || true
adb pull "$SCREENSHOT_DEVICE_DL/." "$SCREENSHOT_HOST/" 2>/dev/null || true
PNG_COUNT="$(find "$SCREENSHOT_HOST" -type f -name '*.png' | wc -l | tr -d ' ')"
ls -la "$SCREENSHOT_HOST" || true
if (( PNG_COUNT < 4 )); then
  log "Expected at least 4 PNGs under $SCREENSHOT_HOST, found $PNG_COUNT" >&2
  # Do not fail the whole instrumented job on screenshot pull alone when the
  # suite itself failed; when the suite passed, missing screenshots are an error.
  if (( GRADLE_RC == 0 )); then
    exit 1
  fi
fi

exit "$GRADLE_RC"
