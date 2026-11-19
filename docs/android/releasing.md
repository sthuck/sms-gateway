# Android release builds (GitHub Releases)

STH-19: CI builds a **signed** prod release APK on version tags (keystore held
only in GitHub Actions secrets) and attaches it to a GitHub Release. Signing is
**all-or-nothing**: missing secrets or a failed `apksigner verify` **fails the
release job** and publishes no GitHub Release/asset. Phones update via
**Obtainium** ([obtainium.md](./obtainium.md)).

## Versioning scheme

| Field | Source | Example |
| --- | --- | --- |
| Git tag | `vMAJOR.MINOR.PATCH` | `v1.2.3` |
| `versionName` | Tag without the leading `v` | `1.2.3` |
| `versionCode` | `MAJOR * 1_000_000 + MINOR * 1_000 + PATCH` | `1002003` |

Rules:

- Tags must match `v*` and parse as `MAJOR.MINOR.PATCH` (optional `-` / `+`
  suffixes are stripped for the numeric code only).
- **`versionCode` must increase on every release** so Android / Obtainium can
  install updates in place. Prefer strictly increasing semver tags
  (`v0.1.0` → `v0.1.1` → `v0.2.0` → …).
- Local / PR builds default to `versionName=0.1.0`, `versionCode=1` when
  `APP_VERSION_NAME` / `APP_VERSION_CODE` are unset (debug and unsigned CI
  artifacts).
- Override either value with env or Gradle properties:
  `-PAPP_VERSION_NAME=…` / `-PAPP_VERSION_CODE=…` (or the same names as env
  vars). The release workflow sets both from the tag.
- `GITHUB_RUN_NUMBER` is logged by the release workflow for diagnostics. If you
  ever need a non-semver-derived code, pass `-PAPP_VERSION_CODE=$GITHUB_RUN_NUMBER`
  explicitly (not the default).

## Cut a release

From a clean `main` (or the commit you intend to ship):

```bash
git checkout main
git pull origin main
git tag -a v0.2.0 -m "Android 0.2.0"
git push origin v0.2.0
```

That push triggers [`.github/workflows/android-release.yml`](../../.github/workflows/android-release.yml)
(tag-push only; no `workflow_dispatch`):

1. Check out `refs/tags/v…` and parse `versionName` / `versionCode`.
2. **Require** all four signing secrets; decode `ANDROID_KEYSTORE_BASE64`
   (job fails immediately if any secret is missing).
3. `./gradlew assembleProdRelease` with R8 minify + shrink.
4. `apksigner verify` the APK; set `signed=true` only after verify succeeds
   (refuse `*-unsigned.apk`).
5. Attach `sms-gateway-<version>-prod-release.apk` to a GitHub Release for that
   tag (generated notes). Nothing is published if verify fails.

## Generate the release keystore

Run once on a trusted machine. **Never commit** the `.jks` / `.keystore` file
or passwords (`.gitignore` already ignores `*.keystore`; keep `*.jks` out of
git as well).

```bash
keytool -genkeypair \
  -keystore sms-gateway-release.jks \
  -alias sms-gateway \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -storepass 'USE_A_LONG_RANDOM_STORE_PASSWORD' \
  -keypass 'USE_A_LONG_RANDOM_KEY_PASSWORD' \
  -dname 'CN=SMS Gateway, OU=Sthuck, O=Sthuck, L=Unknown, ST=Unknown, C=US'

base64 -w0 sms-gateway-release.jks > sms-gateway-release.jks.b64
# macOS: base64 -i sms-gateway-release.jks -o sms-gateway-release.jks.b64
```

Back up the `.jks` and passwords offline. Losing them means you cannot ship
updates that Android will accept as the same app (same signing cert).

## GitHub Actions secrets

Set these four repository secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | Contents of the `.b64` file (single line, no path) |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore store password |
| `ANDROID_KEY_ALIAS` | Alias (e.g. `sms-gateway`) |
| `ANDROID_KEY_PASSWORD` | Key password |

Gradle / the release job also accept the same names as env vars or `-P`
properties. The workflow decodes the base64 secret into
`ANDROID_KEYSTORE_FILE` on the runner; Gradle never reads the base64 blob
directly.

### Missing secrets

| Context | Behaviour |
| --- | --- |
| **Tag release workflow** | **Fails** if any of the four secrets is missing, if Gradle produces an unsigned APK, or if `apksigner verify` fails. No GitHub Release or release asset is published. |
| **Local / PR CI** (`assembleDevDebug`, `assembleProdRelease` without secrets, unit + instrumented tests) | Still works. Gradle prints `Release signing: SKIPPED — …` and may write an `*-unsigned.apk` artifact — that path is for CI/debug only and must never be published as a Release. |

Set the four secrets **before** pushing a `v*` tag.

## Local signed release (optional)

```bash
export ANDROID_KEYSTORE_FILE=/absolute/path/to/sms-gateway-release.jks
export ANDROID_KEYSTORE_PASSWORD=…
export ANDROID_KEY_ALIAS=sms-gateway
export ANDROID_KEY_PASSWORD=…
cd android
./gradlew assembleProdRelease \
  -PAPP_VERSION_NAME=0.2.0 \
  -PAPP_VERSION_CODE=2000
```

## R8 / minify

`release` builds enable `isMinifyEnabled` and `isShrinkResources`. Keep rules
live in `android/app/proguard-rules.pro` (Hilt, Room, Retrofit,
kotlinx.serialization, receivers/services). If a release-only crash appears
after minify, fix keep rules — do not disable minify casually.

## Updates and Obtainium

There is **no in-app update checker**. Distribution and update notifications
are **GitHub Releases + Obtainium** ([install.md](./install.md)).
