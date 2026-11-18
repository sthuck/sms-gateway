#!/usr/bin/env bash
# Fails if AppDatabase version and committed Room schema JSON disagree, or if
# a version bump that has a prior schema JSON lacks an explicit Migration.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_KT="$ROOT/app/src/main/kotlin/com/sthuck/smsgateway/data/local/AppDatabase.kt"
SCHEMA_DIR="$ROOT/app/schemas/com.sthuck.smsgateway.data.local.AppDatabase"

if [[ ! -f "$DB_KT" ]]; then
  echo "AppDatabase.kt not found at $DB_KT" >&2
  exit 1
fi

VERSION="$(grep -E '^const val APP_DATABASE_VERSION' "$DB_KT" | grep -Eo '[0-9]+' | head -n1 || true)"
if [[ -z "$VERSION" ]]; then
  echo "Could not parse APP_DATABASE_VERSION from $DB_KT" >&2
  exit 1
fi

SCHEMA_JSON="$SCHEMA_DIR/${VERSION}.json"
if [[ ! -f "$SCHEMA_JSON" ]]; then
  echo "Missing Room schema JSON for version $VERSION: $SCHEMA_JSON" >&2
  echo "Bump APP_DATABASE_VERSION only together with an exported schema under app/schemas/." >&2
  exit 1
fi

# Highest committed schema must match the Kotlin version constant.
HIGHEST="$(find "$SCHEMA_DIR" -maxdepth 1 -type f -name '*.json' -printf '%f\n' \
  | sed 's/\.json$//' \
  | sort -n \
  | tail -n1)"
if [[ "$HIGHEST" != "$VERSION" ]]; then
  echo "APP_DATABASE_VERSION=$VERSION but highest schema JSON is $HIGHEST.json" >&2
  exit 1
fi

PREV=$((VERSION - 1))
PREV_JSON="$SCHEMA_DIR/${PREV}.json"
if [[ "$VERSION" -gt 1 && -f "$PREV_JSON" ]]; then
  # A contiguous bump from a committed prior schema needs an explicit Migration.
  if ! grep -Eq "Migration[[:space:]]*\([[:space:]]*${PREV}[[:space:]]*,[[:space:]]*${VERSION}[[:space:]]*\)" "$DB_KT" \
    && ! grep -Eq "object[[:space:]]+MIGRATION_${PREV}_${VERSION}" "$DB_KT" \
    && ! grep -Eq "AutoMigration[[:space:]]*\([[:space:]]*from[[:space:]]*=[[:space:]]*${PREV}[[:space:]]*,[[:space:]]*to[[:space:]]*=[[:space:]]*${VERSION}" "$DB_KT"; then
    echo "Room version $PREV -> $VERSION has schema JSON for both versions but no Migration/AutoMigration in AppDatabase.kt" >&2
    echo "Add Migration($PREV, $VERSION) (or AutoMigration) and a MigrationTestHelper case." >&2
    exit 1
  fi
fi

echo "Room schema check OK (version=$VERSION, schema=$SCHEMA_JSON)"
