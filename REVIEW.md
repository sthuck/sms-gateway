# Code review log

Entries are appended by the reviewer. HIGH-severity findings are tracked in Linear (team STH, project "SMS Gateway"), not here.

## 2026-11-19 — owner PATs (agent read access)

| Date | Area | Location | Severity | Description | Suggestion |
| --- | --- | --- | --- | --- | --- |
| 2026-11-19 | Backend | `ResolveOwnerPat` / `owner_access_tokens` | medium | PAT id is embedded in the clear (`smsg_pat_<uuid>_…`). Existence timing on the SECURITY DEFINER lookup can differ for unknown vs known ids before the constant-time hash compare; revoked and wrong-secret still share the same 401 body. | Acceptable for launch; consider hash-only lookup (no id in token) if PAT id enumeration becomes a concern. |
| 2026-11-19 | Backend | PAT `last_used_at` touch | medium | Best-effort throttle uses in-process `lastUsedAt` from the lookup row plus a SQL `INTERVAL '1 minute'` guard; concurrent requests in the same minute can still race a second update. Failures are swallowed so reads never 5xx. | Fine for launch; a single `UPDATE … WHERE last_used_at IS DISTINCT FROM …` is enough. |
| 2026-11-19 | Backend | PAT scope surface | medium | Read scope is enforced in HTTP preHandlers (`requireOwnerWriteAuth`), not in RLS. A future route that forgets the write guard would accept a PAT. | Keep a contract/lint check that every owner mutating route uses `requireOwnerWriteAuth`; stream GETs already do. |

## 2026-11-18 — first pass (PRs #2, #3, #5, #6)

| Date | Area | Location | Severity | Description | Suggestion |
| --- | --- | --- | --- | --- | --- |
| 2026-11-18 | Backend | backend/migrations/1794998580617_initial-schema.cjs:108,130,157,192,206 (PR #2) | minor | Child tables have FKs on `id` only (`messages.device_id`, `stream_membership.stream_id/message_id`, `agent_grants.stream_id`, `device_credentials.device_id`, `audit_log.stream_id`). FK checks bypass RLS, so an owner can insert a row pointing at another owner's UUID, and the FK error/success leaks whether that UUID exists. RLS on reads still hides the data today. | Add `UNIQUE (id, owner_id)` on parents and composite FKs `(x_id, owner_id) REFERENCES parent (id, owner_id)`. |
| 2026-11-18 | Backend | backend/migrations/1794998600880_rls-policies.cjs:77,109 (+ PR #3 lookup_* functions) | minor | SECURITY DEFINER functions use `search_path = pg_catalog, public, app` without `pg_temp` last. The caller's temp schema is searched first for relations, so temp tables can shadow `devices`/`sessions` inside the definer function. | Use `SET search_path = pg_catalog, app, public, pg_temp`, or schema-qualify every table (`public.devices`). |
| 2026-11-18 | Backend | backend/migrations/1794998580617_initial-schema.cjs:139 (PR #2) | minor | `sim_slot` CHECK only enforces `>= 0`. The contract (DeviceMessage.sim_slot) caps it at `maximum: 9`. | `CHECK (sim_slot IS NULL OR sim_slot BETWEEN 0 AND 9)`. |
| 2026-11-18 | Backend | docker-compose.yml:30 (PR #2) | minor | The API container gets `MIGRATE_DATABASE_URL` (superuser) and `SMS_APP_PASSWORD` in its runtime env. That's fine locally, but it teaches a pattern where the app process holds DDL credentials. | Run migrations in a separate one-shot `migrate` service and keep only `DATABASE_URL` on api/worker. |
| 2026-11-18 | Backend | backend/src/auth/identity.ts:60 (PR #3) | minor | `AUTO_LINK_BY_EMAIL` links on any email claim and ignores `email_verified`. It's off by default and labelled dangerous, but turning it on allows takeover through any IdP that lets users set an unverified email. | Require `email_verified === true` before auto-linking. |
| 2026-11-18 | Backend | backend/src/auth/jwt.ts:38-43 (PR #3) | minor | Bearer verification accepts any IdP JWT with `aud = client_id`, including ID tokens. ID tokens aren't meant to be API credentials. | Check `typ` (`at+jwt`) or a token-use claim, or set a distinct `OIDC_AUDIENCE` for API access tokens. |
| 2026-11-18 | Backend | backend/src/routes/auth.ts (POST /v1/auth/logout) (PR #3) | minor | Logout skips the Origin/CSRF checks (logout CSRF). SameSite=Lax mitigates it in most browsers. | Run the same `originAllowed` + double-submit check as other unsafe methods. |
| 2026-11-18 | Backend | backend/src/auth/oauth-state.ts:11-19 (PR #3) | minor | SESSION_SECRET goes straight into the A256GCM key: it's truncated to 32 bytes, or zero-padded when short (zod enforces min 32 chars, so only truncation happens). Only the first 32 chars count. | Derive the key with HKDF-SHA256 over the whole secret. |
| 2026-11-18 | Backend | backend/src/routes/auth.ts (configAsNodeEnv) (PR #3) | minor | The cookie `secure` flag reads `process.env.NODE_ENV` instead of the parsed config, so tests and `buildApp(config)` can disagree. | Pass `config.NODE_ENV` into authRoutes. |
| 2026-11-18 | Backend | backend/src/auth/claims.ts (mapClaims) + users.email NOT NULL (PR #3) | UX | Login hard-fails with a generic 400/500 if the IdP omits `email` (for example, scope mapping not configured), and the user sees "Failed to complete login". | Return a clear `auth_misconfigured` problem naming the missing claim, and document the required Authentik scope mapping. |
| 2026-11-18 | Backend | backend/src/queue/register.ts:101 + worker.ts:59 (PR #5) | minor | `registerDeadLetterObserver` consumes DLQ jobs and marks them completed, so the DLQ doesn't stay "visible" for manual inspect/redrive as docs/queue.md describes. | Don't `work()` the DLQ. Expose counts via `getQueueStats`/metrics polling, or re-throw/keep failed state, and document redrive. |
| 2026-11-18 | Backend | backend/src/queue/register.ts:73 (PR #5) | minor | An invalid payload throws and gets retried `retryLimit` times before dead-lettering, though it can never succeed. | Fail permanently and send it straight to the DLQ for validation errors. |
| 2026-11-18 | Backend | backend/src/queue/config.ts:30 (PR #5) | minor | The metrics server binds `0.0.0.0` with no auth by default. Its counters include queue names only, but the port is exposed on the host in compose (9090). | Default to `127.0.0.1` locally, or keep it cluster-internal only. |
| 2026-11-18 | Backend | backend/src/device/rate-limit.ts:21-23 (PR #6) | minor | The invalid-code lockout (20 invalid per 60 s window) can't be reached because the per-IP limit already caps attempts at 10/60 s. The 15-minute lock never fires. | Count invalid attempts over a longer window (e.g. 15 min), or lower the threshold below the per-IP limit. Add a test. |
| 2026-11-18 | Backend | backend/src/device/rate-limit.ts:21 (PR #6) | UX | The global invalid-code limit (120/min) blocks pairing for every user once it trips. A single noisy client can deny service to legitimate pairing. | Keep a global alarm/metric, but scope blocking per IP or per user (pairing-code owner). Return a clear Retry-After in the web UI. |
| 2026-11-18 | Backend | backend/src/device/plugin.ts:203, pair-auth.ts:160 (PR #6) | minor | QUERY is hardcoded to "" and requests that do carry a query string are still accepted. Query parameters are therefore unsigned. No v1 route reads them today. | Reject device requests with a non-empty query (`400 invalid_request`) until query canonicalisation is implemented. |
| 2026-11-18 | Backend | backend/src/device/replay-cache.ts:24 (PR #6) | minor | Every replay check runs a table-wide `DELETE … WHERE expires_at <= now()`. That's a hot path and causes lock contention under load. | Delete stale rows on a timer or in the worker, or use a single `INSERT … ON CONFLICT` that ignores expired rows. |
| 2026-11-18 | Backend/Android | android DTOs (PR #1) vs backend (PR #6) | minor | Contract check: field names (snake_case via JsonNamingStrategy), status enums (active/revoked, accepted/duplicate/rejected), and headers (X-Device-Id/X-Timestamp/X-Nonce/X-Content-SHA256/X-Signature) all match device-api.yaml and backend. Android signing (STH-11) isn't implemented yet, so this pass can't compare canonical strings end to end. | Once STH-11 lands, add an Android unit test against docs/contracts/examples/test-vector.json, and make sure the body bytes that get hashed are exactly the bytes Retrofit sends (serialise once, send a RequestBody). |

## 2026-11-18 — PR #1 (STH-7 / STH-10), reviewed head 43aa3c46f5b06c2cd8ffb0f42458fb666968356b

| Date | Area | Location | Severity | Description | Suggestion |
| --- | --- | --- | --- | --- | --- |
| 2026-11-18 | Android | android/app/src/main/res/xml/backup_rules.xml:3; data_extraction_rules.xml:4,7 (PR #1) | minor | Rules only `<exclude domain="root"/>`. The Room DB (`database` domain, contains SMS bodies in plaintext) and SharedPreferences are not excluded. `allowBackup=false` mostly covers this, but the explicit rules are what apply to API 31+ device transfer. | Exclude `database`, `sharedpref`, `file`, `external` (and `root`) in both files, or use `<include>` of nothing. |
| 2026-11-18 | Android | android/app/src/main/kotlin/com/sthuck/smsgateway/data/local/QueuedMessageEntity.kt:21 (PR #1) | minor | SMS body and sender are stored as plaintext in app-private Room DB (unencrypted at rest; STH-20 only covers server-side). Rooted/forensic access or a debuggable build exposes OTP/bank SMS backlog. | Keep the outbox short-lived (delete on upload ack), and consider SQLCipher or a Keystore-wrapped field key. Never ship a debuggable prod build. |
| 2026-11-18 | Android | android/app/src/main/kotlin/com/sthuck/smsgateway/sms/SmsReceiver.kt:48 (PR #1) | minor | `scope.launch` has no catch. If `enqueue()` throws (disk full, Room error), the exception reaches the thread's uncaught handler and crashes the app after `pending.finish()`, losing that SMS. The stack trace can include SQL text. | Catch around enqueue; on failure retry via a WorkManager one-shot (carry PDU fields in a retry store) and log only a count/error class, never the body or sender. |
| 2026-11-18 | Android | SmsReceiver.kt:33; SmsPermissionStore.kt (areGranted) (PR #1) | UX | Incoming SMS are silently dropped when RECEIVE_SMS or READ_SMS has been revoked, with no user-visible warning outside the app. The user believes OTPs are being forwarded. Also READ_SMS isn't needed by the live receiver (only for backfill) and is a sensitive Play-policy permission. | Post a persistent notification (or status-bar badge) when permissions are lost. Request READ_SMS only when backfill is enabled. |
| 2026-11-18 | Android | IncomingSmsEnqueuer.kt:23; QueuedMessageDao.kt:21,27 (PR #1) | minor | `ordinal` comes from the count of rows with the same contentKey currently in the queue. Once STH-13 deletes uploaded rows (`deleteById`), a second genuine identical SMS (same sender/body/SMSC second) restarts at ordinal 0, gets the same `device_msg_id`, and the backend answers `duplicate`, so it is silently dropped. Conversely a re-delivered broadcast gets ordinal 1 and uploads twice. | Keep a small tombstone table (contentKey, nextOrdinal) that survives uploads, or mark rows `uploaded` rather than deleting until a TTL. Add a test for upload-then-same-content. |
| 2026-11-18 | Android | android/app/src/main/kotlin/com/sthuck/smsgateway/ui/StatusViewModel.kt:63 (PR #1) | UX | The status screen lists sender numbers of the last 5 queued SMS. Visible in app switcher / screenshots / screen recording. | Mask numbers (e.g. last 2-4 digits) or hide the list in release builds; consider `FLAG_SECURE` on MainActivity. |
| 2026-11-18 | Android | android/app/build.gradle.kts:49,56 (PR #1) | minor | `isMinifyEnabled=false` for release; `proguard-rules.pro` is a placeholder. APK ships unobfuscated; fine for private distribution but must be revisited with Retrofit/kotlinx-serialization/Room keep rules before STH release builds. | Enable R8 for prodRelease and add keep rules, verified by a CI `assembleProdRelease`. |
| 2026-11-18 | Android | .github/workflows/android-ci.yml:69 (PR #1) | minor | CI only builds/lints/tests `devDebug`. The `prod` flavor (https base URL, strict network_security_config, manifest merge) is never compiled, so a prod-only breakage would reach release unnoticed. `--refresh-dependencies` on every run also defeats the Gradle cache and re-resolves unpinned versions. | Add `assembleProdDebug lintProdDebug` (or prodRelease). Drop `--refresh-dependencies` and add `gradle/actions/wrapper-validation` plus `distributionSha256Sum`. |
| 2026-11-18 | Android | android/app/src/main/kotlin/com/sthuck/smsgateway/data/remote/DeviceApi.kt (PR #1) vs backend PR #6 | minor | Signing is not implemented yet (STH-11). For the signature to verify, the bytes hashed into `X-Content-SHA256` must equal the bytes OkHttp sends; a Retrofit `@Body` with the kotlinx converter serialises inside Retrofit, after any signing interceptor has to have seen it. Also the backend only accepts requests whose `Host` header (with port, if any) is in its allow-list, so prod needs `DEVICE_API_PUBLIC_URL`/`PUBLIC_BASE_URL`=`https://sms.sthuck.info` set (deploy config, deferred). | In STH-11, serialise once to bytes, hash them, and send that exact `RequestBody`; add a unit test against docs/contracts/examples/test-vector.json including `Host: 10.0.2.2:4010`. |

## 2026-11-18 — PR #9 (Android pairing, STH-11) and PR #6 re-review

| Date | Area | Location | Severity | Description | Suggestion |
| --- | --- | --- | --- | --- | --- |
| 2026-11-18 | Android | android/.../BackendUrlOverride.kt and DeviceKeyStore.requireSigner() (PR #9) | medium | The URL override is process-global. Any request in flight during pair() would go to the candidate server and be signed with the pending key. Not reachable today; fix before the STH-13 uploader lands. | Scope the override to the pair call with a Retrofit @Tag or marker header, and use the pending key only for that request. |
| 2026-11-18 | Android | DeviceKeyStore.kt commitPendingKey/committedAlias (PR #9) | medium | The key is committed before savePairing. A crash or DataStore failure in between leaves the new key with the old or no device id; a pending key leaked by process death can be picked as the active key (active=B, stale pending=A). Not reachable from the current UI. | Persist the active alias with the credentials, or sweep unreferenced aliases at startup. |
| 2026-11-18 | Android | PairingConfirmationTest (PR #9) | medium | deepLinkConsumedExactlyOnceOnRecreation and pairedDeviceIgnoresInboundDeepLink re-implement the logic locally, so a regression would not fail them. | Drive PairingViewModel with a fake repository and assert pair() is not called on onScannedOrDeepLink. |
| 2026-11-18 | Android | .github/workflows/android-ci.yml schema step and scripts/check-room-schema.sh (PR #9) | medium | The comment claims the step catches commented-out migrations; it doesn't (a version bump with a missing or commented-out Migration passes). Room would throw at runtime in release, so no silent data loss. | Add a MigrationTestHelper.runMigrationsAndValidate test for each n -> n+1. |
| 2026-11-18 | Android | RequestSigningInterceptor.kt (PR #9) | low | invalid_signature wipes the pairing and key on the first occurrence; require(query == null) throws an unchecked exception that could crash on OkHttp's dispatcher thread. | Re-pair only after repeated invalid_signature; return an IOException/failed response instead of throwing. |
| 2026-11-18 | Android | RequestSigningInterceptorTest.signsWithHostPortInCanonicalString (PR #9) | low | It derives the host with the production helper instead of asserting the actual Host header. | Assert the Host header received by MockWebServer. |
| 2026-11-18 | Android | ServerUrlValidator.kt (PR #9) | low | An allow-listed host on a non-default port gets no warning. | Show a warning when the port is non-default. |
| 2026-11-18 | Android | PairingViewModel.kt (PR #9) | low | A stale `confirmation` is not cleared when pairedDeviceId becomes non-null at cold start. | Clear confirmation when the device is paired. |
| 2026-11-18 | Backend | backend/test/fixtures/1795001000000_queue-processed-jobs.cjs (PR #6) | low | Now a dead duplicate of PR #5's migration; migrations.test.ts no longer references it. | Delete it in a follow-up. |
| 2026-11-18 | Backend/Deploy | deploy / DEVICE_ALLOWED_HOSTS | info | `DEVICE_ALLOWED_HOSTS` must include `sms.sthuck.info` (the Android prod default) when deploying, since the backend default does not. |  |

## 2026-11-18 — PR #14 (Drizzle baseline) review

| Date | Area | Location | Severity | Description | Suggestion |
| --- | --- | --- | --- | --- | --- |
| 2026-11-18 | Backend | backend/drizzle catalog-fingerprint.mjs (captureTables, captureFunctions, captureNamespaces, captureDatabase, nonOwnerAcl) | medium | Owner is no longer verified by `stamp`: `ALTER TABLE messages`, `ALTER FUNCTION app.lookup_session` (SECURITY DEFINER), `ALTER SCHEMA app` or `ALTER DATABASE` to `OWNER TO evil` stamps with exit 0. The previous head compared the owner. | Assert every object's owner equals current_user (or the single expected migrator), then filter only that role's ACL rows. Fix before the real cutover. |
| 2026-11-18 | Backend | backend check-drizzle-drift.mjs runGenerateExpectingDrift and catalog-equivalence.test.ts | medium | The negative drift test is vacuous: any output other than the no-op string counts as drift and the temp config can't resolve drizzle-kit; it passed on an unmutated copy, a copy missing its JSON import and a garbage schema. | Require the generated 0001_*.sql file or a specific drizzle-kit drift message, and resolve drizzle-kit from backend/node_modules. |
| 2026-11-18 | Backend | check-drizzle-drift.mjs | low | When drift is detected it leaves the generated 0001_*.sql and a mutated _journal.json in the working tree; only the no-op branch cleans up. | Clean up in a finally block. |
| 2026-11-18 | Backend | check-drizzle-drift.mjs:62-80 push guard | low | Allowlist accepts any line containing 'push guard' or 'no push script', so a commented `drizzle-kit` push invocation (command + `# push guard`) can slip through. | Exempt only comment lines and scan with an exact allowlist of known doc lines. |
| 2026-11-18 | Backend | catalog-equivalence.test.ts | low | The stamp mutation cases never drive schema-equivalence.mjs itself. | Run the real script against each mutated DB. |
| 2026-11-18 | Backend | docs/schema.md | low | A legacy DB whose public schema grants PUBLIC CREATE (PG14-era) is refused by stamp, but the docs give no remedy. | Document `REVOKE CREATE ON SCHEMA public FROM PUBLIC`. |
| 2026-11-18 | Backend | catalog-fingerprint.mjs default-ACL capture | low | It only covers current_user; fine for a single migrator but undocumented. | Add a comment. |

## 2026-11-18 — PR #15, PR #16 and PR #13 minor items

| Date | Area | Location | Severity | Description | Suggestion |
| --- | --- | --- | --- | --- | --- |
| 2026-11-18 | Backend | owner-role tests | low | Owner tests do not cover sms_app on schema public, types, sequences and views. | Add owner/privilege assertions for those object kinds. |
| 2026-11-18 | Backend | push-allowlist failure message | low | The failure message for the push allowlist is unclear. | Name the offending object and the fix. |
| 2026-11-18 | Backend | 'connect as the owning role' refusal text | low | The refusal text is misleading. | Reword to say which role to use. |
| 2026-11-18 | Backend | leftover probe dirs | low | Leftover probe directories remain from the investigation. | Delete them. |
| 2026-11-18 | Backend | drizzle schema/function/foreign-table owner coverage | low | Pre-existing: owner coverage does not extend to drizzle schema, functions or foreign tables. | Extend the owner check. |
| 2026-11-18 | Backend | backend/docs/architecture-layers.md | low | Says infra errors map to '500 / 503' but only 500 occurs; 503 is only the not-configured case. | Say 500 (503 only for not-configured). |
| 2026-11-18 | Backend | backend/docs/architecture-layers.md | low | Lists CSRF rejection under AuthError, but it is a direct 403 problem response. | Move CSRF to the direct-403 note. |
| 2026-11-18 | Backend | backend/docs/architecture-layers.md | low | Mentions a reserved queue-pgboss/ directory that does not exist. | Remove the mention or create it. |
| 2026-11-18 | Backend | backend/docs/architecture-layers.md Logging section; request logging of /v1/auth/callback | low | Doc says OAuth codes must not be logged, but request logging records the code= and state= query on /v1/auth/callback (pre-existing on main; code is single-use and PKCE-bound). | Redact those query params in the request logger. |
| 2026-11-18 | Backend | IdP /token error handling (oidc-provider.ts) | low | Inconsistent mapping: 401 with JSON body -> 400, 401 with empty body -> 500, 429 stays 400. | Define one explicit mapping for 4xx statuses. |
| 2026-11-18 | Backend | PgSessionRepository.touch and ResolveSession touch path | low | Dead code. | Remove it or wire it in. |
| 2026-11-18 | Backend | session expiresAt pass-through | low | No test reads the session expiresAt that is passed through. | Add an assertion. |
| 2026-11-18 | Backend | lint:auth-errors script | low | Tripwire does not catch: catch->sendProblem with 400 or reply.status(400); `catch { return null }` and `.catch(() => undefined/false)`; a comment containing `throw err`; files named rate-limit.ts or replay-cache.ts are skipped anywhere; directories outside the five scanned ones (composition, domain, src/ root) are not scanned. | Widen patterns and scanned dirs, or document the limits. |
| 2026-11-18 | Backend | HTTP matrix test (JWKS/IdP) | low | Does not cover JWKS 404 or hang, IdP /token 500/502. | Add those cases. |
| 2026-11-18 | Backend | backend/src/adapters/auth-oidc/oidc-provider.ts isOidcTokenInfrastructureFailure (~L58-76) | low | An IdP /token hang (openid-client 30 s timeout) or truncated body (OAUTH_PARSE_ERROR) returns 400 invalid_request instead of a retryable 500; same on main, so not a regression (PR #16, head cbe574d). | Also treat OAUTH_PARSE_ERROR and TimeoutError/AbortError (by name) as infrastructure failures. |
| 2026-11-18 | Backend | backend/src/adapters/auth-oidc/jwt.ts | low | A malformed JWK inside a valid JWKS (RSA key without n/e, or an oct key labelled RS256) gives 401 rather than 500; this is an IdP-side fault (PR #16). | Note it in the auth-errors audit. |
| 2026-11-18 | Backend | backend/test/auth/failure-modes.test.ts | low | Deleting only the explicit JWKSMultipleMatchingKeys line in jwt.ts fails no test, because the class-based infra check already excludes it (PR #16). | Add a table-driven test over Object.values of the jose errors asserting the 401/500 bucket per class, so a new jose class forces a decision. |
| 2026-11-18 | Android | UploadScheduler.kt:28 and IncomingSmsEnqueuer.kt:39 | medium | Default ExistingWorkPolicy.APPEND_OR_REPLACE; enqueueUpload() is called with delay 0. After a 5xx, delayed unique work can sit up to 15 min and a newly received SMS appends behind it. | Use REPLACE (or cancel-then-enqueue) when initialDelayMs == 0 and ready rows exist; keep append/delay only for the wake-up. |
| 2026-11-18 | Android | IncomingSmsEnqueuer.kt:25 (M2) | medium | countByContentKey runs after the row is deleted, so dedup fails after upload. | Keep a tombstone or keep uploaded rows until a TTL. |
| 2026-11-18 | Android | outbox storage (M5) | medium | No outbox TTL/cap; plaintext SMS bodies at rest (documented). | Add TTL and a size cap. |
| 2026-11-18 | Android | OutboxUploader.kt:275-278 retryAfterDelayMs | low | Parses only delta-seconds Retry-After; HTTP-date and RateLimit-Reset are ignored. | Parse HTTP-date and RateLimit-Reset. |
| 2026-11-18 | Android | PairingRepositoryTest.kt:290 | low | FakeQueuedDao.unparkAll is a no-op, so dropping unpark-on-successful-pair would not fail the test; unparkAllMakesRowsReadyAgain only exercises the fake DAO, not Room SQL. | Test against in-memory Room. |
| 2026-11-18 | Android | SmsGatewayApplication.kt:45-50 | low | Restore of the preferred key alias and enqueue run in appScope.launch; a delayed worker could start before the alias is restored. | Run restore before enqueue, sequentially. |
| 2026-11-18 | Android | IncomingSmsMapper.kt:84-85 | low | mapSimSlot does not cap at 9. | Cap per contract. |
| 2026-11-18 | Android | IncomingSmsMapper.kt:109,118 | low | sender is not clipped to 64 characters. | Clip per contract. |
| 2026-11-18 | Android | OutboxUploader.kt:57 | low | Body cap uses String.length (UTF-16 units) vs the contract's 32768 Unicode characters. | Count code points. |
| 2026-11-18 | Android | AndroidManifest.xml:59-65, BootUploadReceiver.kt:16-22 | low | BootUploadReceiver is exported + directBootAware but credential-encrypted storage may be unavailable at locked boot. | Drop directBootAware or handle locked state. |
| 2026-11-18 | Android | OutboxUploader.kt:27 | low | Unused UploadPassResult.Failed. | Remove. |
| 2026-11-18 | Android | BatchPacker.kt:34-35 | low | Comment says body_too_large for a single oversized item, but the uploader parks it as payload_too_large. | Fix the comment. |

## 2026-11-18 — PR #18 (outbox follow-ups) medium findings

Recorded from the Code Reviewer while on the STH-47 keepalive branch. Not fixed here.

| Date | Area | Location | Severity | Description | Suggestion |
| --- | --- | --- | --- | --- | --- |
| 2026-11-18 | Android | OutboxUploader + StatusViewModel.retryParked (PR #18) | medium | `enforceLimits` re-parks TTL-expired rows on Retry; explicit retry still hits housekeeping TTL. | Skip TTL on explicit retry, or add a grace flag so Retry parked does not immediately re-park. |
| 2026-11-18 | Android | AppDatabase MIGRATION_3_4 (PR #18) | medium | Seeds `nextOrdinal` with `COUNT(*)` instead of `max(ordinal)+1`; drained `contentKeys` are missing from counters. | Seed from `max(ordinal)+1` per key (including tombstones / drained keys). |
| 2026-11-18 | Android | UploadScheduler delay-0 REPLACE (PR #18) | medium | Delay-0 `REPLACE` cancels an in-flight drain; racing enqueues can abort a live worker. | Prefer `REPLACE` only when existing unique work is delayed; keep in-flight drains. |

## 2026-11-18 — PR #22 (Android background survival, STH-47) and PR #25 (ingestion poison-item fix)

| Date | Area | Location | Severity | Description | Suggestion |
| --- | --- | --- | --- | --- | --- |
| 2026-11-18 | Android | BatteryOptimization.kt:32-36, MainActivity onRequestBatteryExemptClick | medium | Uses ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (fine for sideload, Play-policy risk) with no ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS fallback. | Keep the direct request for sideload, catch ActivityNotFoundException and fall back to the settings screen; call out the Play restriction if a Play build appears. |
| 2026-11-18 | Android | HeartbeatClient.kt:34, RequestSigningInterceptor.kt:113-121 | medium | If HEARTBEAT_ENABLED is later turned on, a 401 invalid_signature / 403 device_revoked on the heartbeat still goes through the interceptor and clears pairing / deletes the key before HeartbeatClient can treat it as non-blocking (404 is safe; default-off so not live). | Exclude heartbeat from credential-wipe, or handle 401 without unpairing, before enabling the flag. |
| 2026-11-18 | Android | HeartbeatClientTest, OemSetupLauncher, KeepaliveController | medium | HeartbeatClientTest uses a fake DeviceApi (no interceptor); no test that a 401 heartbeat cannot wipe credentials; OemSetupLauncher and KeepaliveController start-failure swallowing untested. | Add those tests. |
| 2026-11-18 | Android | GatewayKeepaliveService.kt:108-124 | low | Notification content is generic but visibility is not set explicitly (compat default PRIVATE). | setVisibility(PRIVATE or SECRET) and channel setLockscreenVisibility. |
| 2026-11-18 | Android | BootUploadReceiver.kt:38 | low | runBlocking on the main thread to read DataStore in onReceive. | Prefer goAsync(). |
| 2026-11-18 | Android | MainActivity | low | startActivity for the battery-exemption and OEM deep-link/fallback intents is unguarded; a missing activity can crash. | Wrap and fall back. |
| 2026-11-18 | Android | POST_NOTIFICATIONS flow | low | Only requested when the user taps the checklist button, not automatically after pairing (API 33+). | Request after pairing. |
| 2026-11-18 | Backend | backend/src/domain/message/validate.ts (containsNul branch) | medium | A NUL in device_msg_id is echoed back as device_msg_id: ""; Android looks results up by id, so it treats the row as missing_result and retries forever instead of parking (other items unaffected; Android never generates such ids). | Return the received id as the too-long branch does and assert results[2].device_msg_id in the use-case test. |
| 2026-11-18 | Backend | validate.ts (body NUL check) | medium | NUL in body is a new rejection the DB never needed (body goes to bytea body_ciphertext); a rare SMS decoding with U+0000 would be rejected and parked on the device. | Drop the check or document it as intentional policy. |
| 2026-11-18 | Backend | backend/bench/ingest-batch.ts | low | --host "[::1]:3000" is falsely refused (fails safe); a DB URL like postgres://localhost/sms?host=remote slips past the guard because pg's host query param overrides the URL host. | Parse host query params in the guard. |
| 2026-11-18 | Backend | backend/bench/ingest-batch.ts | low | SIGINT skips the finally; a half-failed seed leaks the user; pg-boss jobs from the run are not cleaned up. | Handle SIGINT and clean pg-boss jobs. |
| 2026-11-18 | Backend | received_at parsing (pre-existing) | low | Date.parse may roll 2026-02-30 or 24:00:00 forward instead of rejecting them; no test covers it. | Round-trip check against the input. |

## 2026-11-18 — PR #18 (Android outbox follow-ups) and PR #19 (Backend device/queue hexagonal move)

| Date | Area | Location | Severity | Description | Suggestion |
| --- | --- | --- | --- | --- | --- |
| 2026-11-18 | Android | OutboxUploader.kt:54, StatusViewModel.kt:133-134 | medium | retryParked() unparks, then runOnce runs enforceLimits first and re-parks expired_ttl rows, so Retry cannot upload unsent SMS older than 7 days (rows stay visible, not deleted). | Skip the TTL re-park on an explicit Retry, or add a grace flag. |
| 2026-11-18 | Android | AppDatabase.kt:58-59 (MIGRATION_3_4 seed) | medium | Seed uses COUNT(*), wrong when earlier ordinals were already deleted (should be max(ordinal)+1); fully drained pre-upgrade contentKeys get no counter, so a later same-key SMS can reuse ordinal 0 and hit backend duplicate. Migration test covers only the dense in-outbox case. | Seed with max(ordinal)+1 and add a drained-case migration test. |
| 2026-11-18 | Android | UploadScheduler.kt:83-87 | medium | delay-0 REPLACE can cancel an in-flight drain; no data loss given duplicate->delete, but bursts can thrash the worker. UploadSchedulerPolicyTest only asserts the helper. | REPLACE only when existing work is delayed; APPEND_OR_REPLACE when it is running. |
| 2026-11-18 | Android | retryAfterDelayMs | low | RateLimit-Reset still ignored. | Parse it. |
| 2026-11-18 | Android | status screen/docs | low | 'up to 2 000 messages for 7 days' understates unbounded parked plaintext rows. | Reword the retention copy. |
| 2026-11-18 | Android | SmsGatewayApplication.kt:52-55 | low | runBlocking on the main thread for alias restore (race fixed; small ANR risk). | Restore off the main thread but before enqueue. |
| 2026-11-18 | Android | content_key_counters | low | No TTL on counters. | Add cleanup. |
| 2026-11-18 | Android | housekeeping tests | low | Omit the unpark-then-enforceLimits case. | Add it. |
| 2026-11-18 | Backend | backend/test/device/parity-matrix.test.ts | medium | Static table asserting against its own constants; never calls the app. | Drive the real app or remove. |
| 2026-11-18 | Backend | backend/test/auth/failure-modes.test.ts ('pairing-codes DB failure') | medium | Fails the session lookup first so it never reaches the pairing_codes insert. | Use a healthy session with a fault on just that insert. |
| 2026-11-18 | Backend | HTTP-level tests | medium | No infra-failure tests for pair, /v1/devices/me, revoke, replay claim; no unit tests for the five new use cases (repository-contract tests do cover all new Postgres port methods). | Add them. |
| 2026-11-18 | Backend | backend/src/adapters/http-fastify/device-routes.ts (pair catch) | low | A DB error in the rate-limit check, noteInvalidCode or the proof-of-possession replay claim returns 500 'Failed to pair device' (main: 500 'Unexpected error'); status/code/retryable same but RateLimit headers no longer set on that 500. | Keep headers or accept. |
| 2026-11-18 | Backend | adapters/http-fastify/pair-auth.ts, device-routes.ts | low | pair-auth.ts calls db-postgres/replay-cache directly instead of the ReplayCache port and duplicates header/skew/hash checks owned by ResolveDeviceAuth; device-routes.ts imports rateLimitHeaders from db-postgres. | Add a PairProofOfPossession use case later. |
| 2026-11-18 | Backend | device-routes.ts revoke handler | low | Now checks not-configured (503) before UUID validity (400); the 400's instance drops the query string. | Restore main's order. |
| 2026-11-18 | Backend | the five new device use cases | low | Wrap any non-DeviceError as InfrastructureError('... failed'), so programmer bugs are labelled infra in logs (500 is the same as main). | Only wrap known infra errors. |
| 2026-11-18 | Backend | QueuePublisher / PgBossQueuePublisher | low | Not wired into buildDeviceStack or any route yet (groundwork for PR C). | None, note only. |
| 2026-11-18 | Backend | lint:auth-errors | low | No longer scans src/routes, src/device, src/queue; nothing there catches errors today. | Re-add if error handling appears there. |
| 2026-11-18 | Backend | domain isTimestampInWindow | low | Lost its default skewSec. | Restore default or confirm callers pass it. |
| 2026-11-18 | Backend | src/device/*, src/queue/* | low | Thin re-exports and @deprecated DeviceAuthRow/PairingCodeRow aliases remain. | Remove once callers migrate. |

## 2026-11-18 — PR #21 (STH-15 message ingestion)

| Date | Area | Location | Severity | Description | Suggestion |
| --- | --- | --- | --- | --- | --- |
| 2026-11-18 | Backend | backend/src/domain/message/normalise.ts, domain/message/validate.ts, adapters/db-postgres/message-repository.ts | medium | A U+0000 character in sender or device_msg_id passes validation but Postgres rejects it (SQLSTATE 22021); received_at with year 0000 passes the regex, then timestamptz rejects it. Either rolls the whole batch back into a retryable 500 on every retry; Android never parks a 500, so that device's outbox stalls. | Reject NUL per item as invalid_field, add a lower bound on received_at (1970 or 2000), optionally a SAVEPOINT per item mapping SQLSTATE class 22 to a rejection. |
| 2026-11-18 | Backend | tests for POST /v1/messages:batch | medium | Missing: parallel identical batches, mid-batch failure (fault on item 2+, item 1 not persisted, response 500), HTTP-level infra failure for the route (only use-case level covered), poison-item cases. | Add them. |
| 2026-11-18 | Backend | backend/bench/ingest-batch.ts | medium | Seeds a user, active device and credential bound to the public test-vector key into whatever DB URL is set, no host guard, no cleanup; against a real DB it leaves a device credential anyone with the repo can sign for (owner is a throwaway). | Refuse non-localhost hosts without an explicit flag; delete the seeded user at the end. |
| 2026-11-18 | Backend | validate.ts | low | Non-string device_msg_id returns missing_field instead of invalid_field. | Return invalid_field. |
| 2026-11-18 | Backend | message repository transaction | low | Overlapping batches with different item order can deadlock (40P01) giving a retryable 500. | Sort by device_msg_id inside the transaction. |
| 2026-11-18 | Backend | message repository inserts | low | One round trip per item; fine at the benchmarked p95 of ~85 ms. | Consider unnest batching later. |
| 2026-11-18 | Backend | received_at handling | low | Loses microseconds because toISOString() is millisecond precision. | Accept or preserve precision. |
| 2026-11-18 | Backend | last_seen_at | low | Not updated when every item in a batch is rejected. | Decide if intended. |
| 2026-11-18 | Backend | rate limit | low | Tokens consumed before validation and on attempts that later return 500; default 10,000 messages/hour per device may throttle a large backfill. | Revisit the limits. |
| 2026-11-18 | Backend/Deploy | INGEST_DEFAULT_PHONE_REGION | low | Defaults to US; set to IL in deployment so national-format senders normalise. | Set it in the Helm values/env. |
| 2026-11-18 | Backend | adapters/http-fastify/message-routes.ts | low | MAX_PAYLOAD_BYTES check duplicates the one in device auth; `void body.owner_id` statements are no-ops. | Remove. |
| 2026-11-18 | Backend | request schema | low | Unknown top-level keys tolerated although the schema says additionalProperties: false. | Harmless; align or document. |

## 2026-11-19 — STH-21 owner REST (messages + devices)

| Date | Area | Location | Severity | Description | Suggestion |
| --- | --- | --- | --- | --- | --- |
| 2026-11-19 | Backend | GET /v1/messages `q` | medium | Text search is case-insensitive substring on decrypted body only. No owner-facing regex filter is exposed (CompileSafeRegex / re2 remains the seam for stream rules). | Add an explicit `q_regex` (or documented regex mode) via CompileSafeRegex if product needs it; keep scan/page caps. |
| 2026-11-19 | Backend | ListMessages search pagination | medium | When `q` is set, each request decrypts at most `MAX_MESSAGE_SEARCH_SCAN` (500) candidates. Hitting the scan cap with fewer than `limit` matches returns a `next_cursor` past the scanned window; dense matches after a short page still keyset from the last returned id (may re-decrypt non-matches between pages). | Acceptable for launch; revisit blind index / larger caps only with a privacy trade-off review (ADR 0002). |
| 2026-11-19 | Backend | DELETE /v1/messages/{id} | medium | Second delete of the same id returns `404` (not `204`). Required so other-owner deletes stay `404` under RLS; unlike device revoke which is idempotent `204`. | Document in client SDKs; treat 404 as success for “ensure gone” if needed. |

## 2026-11-19 — PR #34 review (STH-21, approved/merged)

| Date | Area | Location | Severity | Description | Suggestion |
| --- | --- | --- | --- | --- | --- |
| 2026-11-19 | Backend | `list-messages.ts` `decodeRow` | medium | One undecryptable row fails the whole page with a non-retryable 500. | Return that row with `body: null` plus a `decrypt_error` flag, or skip and log by id only. |
| 2026-11-19 | Backend | `/v1/messages*` (+ stream message responses) | minor | No `Cache-Control: no-store` on responses carrying decrypted SMS text. | Add the header. |
| 2026-11-19 | Backend | `list-messages.ts` date filters | minor | `received_after`/`before` use lenient `new Date(raw)` (timezone-less strings are server-local). | Require ISO 8601 with Z or offset. |
| 2026-11-19 | Backend | `sender` filter | minor | Exact match on normalised sender; query input is not normalised like ingest. | Normalise the input like ingest, or document exact-match semantics. |
| 2026-11-19 | Backend | device rename / device routes | minor | NUL in device `name` can yield retryable 500; device routes return 500 on infra where message routes return 503. | Reject NUL with 400; align device infra mapping to 503. |
| 2026-11-19 | Backend | `docs/contracts/user-api.yaml` | minor | Missing declared 400 on `getMessage`/`deleteMessage` and 503 on `deleteMessage`. | Declare those responses. |
| 2026-11-19 | Backend | DELETE vs ingest recreate | UX | Second DELETE returns 404; device resend of same `device_msg_id` recreates the deleted row and fires `message.created` again. | Document or keep a tombstone. |
| 2026-11-19 | Backend | composition / message inbox UCs | minor | Message read/delete use cases exist only when a queue publisher is configured (owner reads return 503 without pg-boss). | Build the message repository independently of the queue. |
| 2026-11-19 | Backend | tests | minor | Gaps: multi-value `q`, search scan cap, HTTP-level owner-read key outage, corrupt-row listing, renaming a revoked device, cascade delete of stream memberships. | Add them. |

## 2026-11-19 — Web UI part A (STH-16)

| Date | Area | Location | Severity | Description | Suggestion |
| --- | --- | --- | --- | --- | --- |
| 2026-11-19 | Web | Pairing completion via GET /v1/devices poll | medium | No dedicated pairing-status / SSE endpoint; UI detects success by a new device id not in the pre-issue `GET /v1/devices?limit=100` snapshot (delta). A second owner tab that pairs another phone in the same window can look like success for this code; concurrent revoke+re-pair of an existing id is invisible. | Add owner-facing GET /v1/pairing-codes/{id} or SSE when product needs certainty. |
| 2026-11-19 | Web | Deploy | medium | Helm still serves API only; production same-origin SPA serving (static + /v1) is not wired. Local Vite proxy is documented. | Add a web static deploy or ingress path when shipping to sms.sthuck.info. |
| 2026-11-19 | Web | VITE_APK_DOWNLOAD_URL | medium | Install/APK link is a config placeholder until Android release publishes a URL. | Set the env at build time once the APK is published. |

## 2026-11-19 — Web UI part B (inbox, devices, tokens)

| Date | Area | Location | Severity | Description | Suggestion |
| --- | --- | --- | --- | --- | --- |
| 2026-11-19 | Web | `AuthContext.refresh` | info | Part B: `/v1/auth/me` 5xx or network errors no longer clear the session; only `401` (including `mfa_required`) sets anonymous. Boot failures surface `boot_error` + Retry in `RequireAuth` / login. | None. |
| 2026-11-19 | Web | Inbox | medium | Inbox is poll-on-load / manual “Load more” only; no SSE or live updates when new SMS arrive. | Add SSE or periodic refresh when product needs a live inbox. |
| 2026-11-19 | Web | Body search pagination | medium | With `q` set, short pages require explicit “Keep searching” while `next_cursor` is present (search scan cap). Easy to mistake for end-of-results without reading the button label. | Optional inbox hint when search is active; backend caps documented in contract. |
| 2026-11-19 | Web / Backend | `GET /v1/devices` + devices/inbox/pairing UI | medium | Device list is capped at 100 with no cursor (`list-devices` / `?limit=100`). Devices beyond 100 cannot be listed, renamed, or revoked; inbox device filter and pairing snapshots are incomplete past that cap. | Add a cursor (or higher cap) on the owner devices list, or surface the cap in the UI. |
