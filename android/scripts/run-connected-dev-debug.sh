#!/usr/bin/env bash
# Runs connectedDevDebugAndroidTest against a booted emulator and injects
# SMS from the host via `adb emu sms send` while the tests poll the outbox.
#
# Also installs APKs and runs UiScreenshotTest via am instrument so CI always
# produces PNGs under app/build/screenshots (Gradle's connected task has been
# finishing in seconds without leaving a durable test install).
#
# Used by the GitHub Actions `instrumented` job. Locally, start an emulator
# first, then run this script from android/ (or any cwd; it cds itself).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PACKAGE="com.sthuck.smsgateway.dev"
TEST_PACKAGE="${PACKAGE}.test"
RUNNER="androidx.test.runner.AndroidJUnitRunner"
SINGLE_SENDER="+15551234567"
MULTIPART_SENDER="+15559876543"
TOKEN="${SMS_E2E_TOKEN:-${GITHUB_RUN_ID:-local}-$(date +%s)}"
DEADLINE=$((SECONDS + 240))
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

run_ui_screenshots() {
  log "Installing app + androidTest APKs for UiScreenshotTest"
  ./gradlew installDevDebug installDevDebugAndroidTest --stacktrace

  log "Installed instrumentations:"
  mkdir -p "$ROOT/app/build/reports"
  adb shell pm list instrumentation | tee "$ROOT/app/build/reports/instrumentation-list.txt" || true

  local component
  component="$(
    adb shell pm list instrumentation \
      | sed -n "s/^instrumentation:\(${TEST_PACKAGE}\/[^ ]*\).*/\1/p" \
      | head -n 1 \
      | tr -d '\r'
  )"
  if [ -z "$component" ]; then
    component="${TEST_PACKAGE}/${RUNNER}"
  fi
  log "Running UiScreenshotTest via $component"
  set +e
  adb shell am instrument -w -r \
    -e class com.sthuck.smsgateway.ui.UiScreenshotTest \
    "$component" \
    | tee "$ROOT/app/build/reports/ui-screenshot-instrument.txt"
  local rc=${PIPESTATUS[0]}
  set -e
  pull_screenshots
  local count
  count="$(png_count)"
  if (( count < 4 )); then
    log "Expected at least 4 PNGs under $SCREENSHOT_HOST, found $count" >&2
    return 1
  fi
  return "$rc"
}

log "E2E token: $TOKEN"
adb wait-for-device
adb shell setprop debug.smsgateway.e2e_token "$TOKEN"

# Screenshots first: dedicated install + am instrument (does not depend on the
# connected Gradle task leaving the test APK installed).
set +e
run_ui_screenshots
SCREENSHOT_RC=$?
set -e

send_sms_when_ready &
SENDER_PID=$!

set +e
./gradlew connectedDevDebugAndroidTest --stacktrace
GRADLE_RC=$?
set -e

# Don't leave a stuck sender if gradle failed early.
wait "$SENDER_PID" || true

# Prefer screenshots already captured; pull again in case connected suite wrote more.
pull_screenshots || true

if (( SCREENSHOT_RC != 0 )); then
  log "UiScreenshotTest / screenshot pull failed (rc=$SCREENSHOT_RC)" >&2
  exit "$SCREENSHOT_RC"
fi

exit "$GRADLE_RC"
