#!/usr/bin/env bash
# Prism mock of the STH-5 device API (docs/contracts/device-api.yaml, v1 draft 2).
# Prefer the repo Compose profile when you already have Docker up:
#   docker compose --profile mock up mock-api
# From the emulator, the host is http://10.0.2.2:4010 (see android/README.md
# and docs/local-dev.md).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTRACT="$REPO_ROOT/docs/contracts/device-api.yaml"
PORT="${PORT:-4010}"

if [ ! -f "$CONTRACT" ]; then
  echo "Contract not found at $CONTRACT" >&2
  exit 1
fi

echo "Starting Prism mock on http://127.0.0.1:${PORT}"
echo "Spec: $CONTRACT"
echo "Android emulator should use http://10.0.2.2:${PORT}"
exec npx --yes @stoplight/prism-cli mock -h 0.0.0.0 -p "${PORT}" "$CONTRACT"
