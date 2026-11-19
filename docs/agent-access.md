# Agent access (owner PATs)

Long-lived personal access tokens let a script or AI agent **read** an owner's
full SMS inbox. PATs are read-only: they cannot write, manage tokens, touch
streams, or revoke devices (`403 forbidden`).

## Create a token

Requires a browser session (or OIDC JWT) — not another PAT.

```bash
curl -sS -X POST "$BASE/v1/tokens" \
  -H "Cookie: sms_session=$SESSION" \
  -H "X-CSRF-Token: $CSRF" \
  -H "Origin: $BASE" \
  -H "Content-Type: application/json" \
  -d '{"name":"agent-reader"}'
# → { "id":"…", "name":"agent-reader", "token":"smsg_pat_<uuid>_<secret>", … }
# Store `token` once; it is never returned again.
```

## Read messages

```bash
export TOKEN='smsg_pat_…'
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/messages?limit=100"
```

### Cursor pagination

```bash
CURSOR=
while :; do
  RESP=$(curl -sS -H "Authorization: Bearer $TOKEN" \
    "$BASE/v1/messages?limit=100${CURSOR:+&cursor=$CURSOR}")
  echo "$RESP" | jq '.messages'
  CURSOR=$(echo "$RESP" | jq -r '.next_cursor // empty')
  [ -z "$CURSOR" ] && break
done
```

### Search, device, and date filters

```bash
# Substring search on decrypted body
curl -sS -H "Authorization: Bearer $TOKEN" \
  --get "$BASE/v1/messages" --data-urlencode "q=OTP" --data-urlencode "limit=50"

# Device + date range
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE/v1/messages?device_id=$DEVICE_ID&received_after=2026-01-01T00:00:00Z&received_before=2026-02-01T00:00:00Z"
```

### Search budget (`200` + `next_cursor`)

When `q` is set, each request decrypts a bounded scan window. Hitting the scan
or time budget with fewer than `limit` matches still returns **HTTP 200** with a
`next_cursor` past the scanned window. Keep following `next_cursor` until it is
null — do not treat a short page as the end of results.

## List devices

```bash
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/v1/devices"
```

## Revoke

```bash
curl -sS -X DELETE "$BASE/v1/tokens/$TOKEN_ID" \
  -H "Cookie: sms_session=$SESSION" \
  -H "X-CSRF-Token: $CSRF" \
  -H "Origin: $BASE"
# Idempotent 204. Unknown / other-owner id → 404.
```
