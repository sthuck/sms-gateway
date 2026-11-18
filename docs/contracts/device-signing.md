# Device request signing (STH-5 v1 draft 2)

This document is the normative signing scheme for the device API in
`device-api.yaml`. The worked example at the end is a real computed
vector. Both Android and the backend should unit-test against it.

**Changelog:** v1 draft 2, Android review applied. Body cap 32768;
optional `server` in the pairing QR; `Date` + `server_time` on
`invalid_timestamp`; `401 device_unknown`; cleartext HTTP only for the
Android `dev` mock at `10.0.2.2:4010`; request bodies signed over the
exact bytes on the wire (no gzip / no `Content-Encoding`).

## Algorithm choice: ES256 (ECDSA P-256 + SHA-256)

**v1 uses ES256 only.** Ed25519 is not accepted.

Android Keystore supports Ed25519 only from API 33. The signing
scheme's contract floor is API 23 (`SHA256withECDSAinP1363Format`).
The app's minSdk is 26. P-256 is available in Keystore from API 23,
hardware-backed on typical devices, and straightforward to verify in
Node.js (`crypto.verify` with `dsaEncoding: 'ieee-p1363'`).

| Item | v1 value |
| --- | --- |
| JWA alg | `ES256` |
| Curve | NIST P-256 (`prime256v1` / `secp256r1`) |
| Hash | SHA-256, applied to the canonical string (UTF-8 bytes) |
| Public key | X.509 SubjectPublicKeyInfo (SPKI) DER, unpadded base64url |
| Signature | IEEE P1363 raw `r \|\| s` (32 + 32 bytes, big-endian, zero-padded), unpadded base64url (86 characters) |
| Header encoding of hashes | lowercase hex (64 characters) |

P1363 is used instead of ASN.1 DER so the signature has a fixed
length and matches JWS/WebAuthn practice. On Android use
`Signature.getInstance("SHA256withECDSAinP1363Format")`. Do not send
DER (`SHA256withECDSA`); the backend will reject it.

The public key sent at pairing is `PublicKey.getEncoded()` (X.509
SPKI). In Node, import it as `createPublicKey({ key: der, format: 'der', type: 'spki' })`.

## Transport

Production and the Android prod flavour are **HTTPS only**.

The Android `dev` flavour is a documented exception: it talks to the
local mock over **cleartext HTTP** at `http://10.0.2.2:4010` (the
emulator's host loopback). In that case the `Host` header includes
the port: `10.0.2.2:4010`. That value is kept as sent, lowercased, and
the port is part of the canonical `HOST` field.

## Headers

Every device request, including pairing and GET, includes:

| Header | Required | Notes |
| --- | --- | --- |
| `Host` | yes | Standard host header. Lowercased in the canonical string. Include the port only if the client put one in `Host` (e.g. `10.0.2.2:4010` for the dev mock). The request `Host` must match the host used in the signed canonical string and must be an allowed backend host. |
| `X-Device-Id` | all except `POST /v1/devices/pair` | UUID returned at pairing. |
| `X-Timestamp` | yes | Unix seconds (UTC), decimal, no leading zeros. |
| `X-Nonce` | yes | 16–64 bytes of CSPRNG output, unpadded base64url (22–86 chars). |
| `X-Content-SHA256` | yes | Lowercase hex SHA-256 of the **exact request body bytes sent on the wire**. Empty body → SHA-256 of zero bytes, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. |
| `X-Signature` | yes | P1363 signature, unpadded base64url. |
| `Content-Type` | POST | `application/json`. Not part of the canonical string; the body hash covers the bytes. |

Request bodies are signed over the exact bytes sent on the wire. The
client must hash and send those bytes as-is: **no re-serialisation**
after computing `X-Content-SHA256`. Clients must not gzip or otherwise
compress request bodies. `Content-Encoding` on requests is not
supported in v1 and is rejected with `400 invalid_request`.
`X-Content-SHA256` covers those exact bytes.

`X-Content-SHA256` must equal the hash of the received body, otherwise
the server returns `400 content_hash_mismatch` and does not verify the
signature.

## Canonical string

UTF-8, nine fields joined by `\n` (U+000A). **No trailing newline
after `NONCE`.**

```
v1
METHOD
PATH
QUERY
HOST
DEVICE_ID
TIMESTAMP
CONTENT_SHA256
NONCE
```

| Field | Rule |
| --- | --- |
| `v1` | Literal scheme version. |
| `METHOD` | Uppercase HTTP method (`POST`, `GET`). |
| `PATH` | Path only, beginning with `/`. No scheme, host, query, or fragment. No trailing-slash normalisation; it must match the request-target path exactly. |
| `QUERY` | Empty string for these v1 endpoints (they have no query string). If a query is ever added: parse `key=value` pairs, percent-decode, sort by key then value (UTF-8 byte order), percent-encode with RFC 3986 unreserved characters left as-is, join with `&`. A missing query and an empty query are both the empty field. |
| `HOST` | `Host` header, lowercased. The port is included when the client sent one (e.g. `10.0.2.2:4010`). No other normalisation. |
| `DEVICE_ID` | Exact `X-Device-Id`, or empty on `POST /v1/devices/pair`. |
| `TIMESTAMP` | Exact `X-Timestamp` value. |
| `CONTENT_SHA256` | Exact `X-Content-SHA256` value (lowercase hex). |
| `NONCE` | Exact `X-Nonce` value. |

The server also checks that `HOST` is one of its expected public
hosts, so a captured request cannot be replayed against another
environment. When the pairing QR includes a `server` parameter, the
request `Host` must be the host (and port, if any) of that base URL
and must match this canonical `HOST` field.

## Clock skew and replay

- Accept `X-Timestamp` only if it is within **±300 seconds** of server
  UTC time. Otherwise `401 invalid_timestamp` (`retryable: true`).
  That response **must** include a standard `Date` response header and
  a `server_time` field (Unix seconds integer) in the problem+json
  body, so the app can compute a clock offset and re-sign.
- Remember `(identity, nonce)` and `(identity, signature)` for **360
  seconds**. A repeat inside that window is `401 replay_detected`
  (`retryable: true`). Identity is `device_id`, or the SHA-256 of the
  SPKI bytes at pairing.
- On retry the client **must** generate a new nonce, a fresh
  timestamp, recompute the content hash if the body changed, and
  resign. Never resend the same signed headers.

## Pairing: proof of possession

`POST /v1/devices/pair` is authorised by a valid, unexpired, unused
pairing code **and** a signature that verifies under the `public_key`
in the JSON body. The canonical `DEVICE_ID` field is empty.

The web UI presents a pairing QR (and the raw code) of the form:

```
smsgw://pair?code=<code>
```

An optional `server` query parameter may be added, whose value is the
URL-encoded API base URL, so the app does not need a hardcoded
backend:

```
smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fapi.sms-gateway.example
```

The request `Host` must be the host (and port, if any) of that base
URL, must match the `HOST` field in the signed canonical string, and
must be one of the server's allowed backend hosts.

If the public key in the body is swapped, the body hash changes and
the original signature will not verify. A signature produced by a
different key only verifies if that key is the one in the body; the
attacker still needs a fresh pairing code.

`alg` must be `ES256`. The public key must be a valid P-256 SPKI.
Failed checks are `400 invalid_public_key` or `400 invalid_pairing_code`.

## Worked example (test vector)

**The keypair below is a throwaway test vector. Never use it in
production, never provision it to a real device, and never accept it
as a registered key.**

The source of this vector, and a verifier, is
`docs/contracts/examples/gen-test-vector.mjs`. A machine-readable copy is
`docs/contracts/examples/test-vector.json`. Run:

```bash
node docs/contracts/examples/gen-test-vector.mjs
```

The script exits 0 only if the frozen signature verifies, a freshly
produced signature also verifies, a tampered canonical string is
rejected, and the optional dev-host (port-in-`HOST`) vector also
verifies.

### Test private key (PKCS#8 PEM) — THROWAAWAY

```
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg0tCxCFGtAN6rIAQX
RpKMgFrWNK9OPHLpPPnwmPtjsXihRANCAATKXotA6HRWiXpjt5R5imu0w8P9wH2h
XBEUEBDoGlxFtdkBcuXvjmMp367FfhvBSUfEf6Mewxz//+bdaU6C7HBF
-----END PRIVATE KEY-----
```

### Test public key (SPKI PEM and base64url DER)

```
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyl6LQOh0Vol6Y7eUeYprtMPD/cB9
oVwRFBAQ6BpcRbXZAXLl745jKd+uxX4bwUlHxH+jHsMc///m3WlOguxwRQ==
-----END PUBLIC KEY-----
```

Unpadded base64url SPKI DER (this is what `public_key` looks like at
pairing):

```
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyl6LQOh0Vol6Y7eUeYprtMPD_cB9oVwRFBAQ6BpcRbXZAXLl745jKd-uxX4bwUlHxH-jHsMc___m3WlOguxwRQ
```

### Fixed inputs

| Input | Value |
| --- | --- |
| Method | `POST` |
| Path | `/v1/messages:batch` |
| Query | (empty) |
| Host | `api.sms-gateway.example` |
| X-Device-Id | `018f3c2a-9b4d-7e21-a456-426614174000` |
| X-Timestamp | `1794995160` (2026-11-18T09:46:00Z) |
| X-Nonce | `V1nQe4r0sK8mP2yL6dF9TQ` |

Request body, **exactly these 166 UTF-8 bytes** (compact JSON, no
trailing newline, the exact bytes sent on the wire):

```
{"messages":[{"device_msg_id":"sms-42","sender":"+15551234567","body":"Your code is 123456","received_at":"2026-11-18T09:45:12Z","sim_slot":0,"direction":"inbound"}]}
```

### Body hash

`SHA-256(body)` lowercase hex:

```
8745a7b3b4b4b1fd81d08106e22e2d6261a203d0fc673b7cbf4aa7fbdeee4ea9
```

### Canonical string

Eight newline characters, no trailing newline. Shown with `\n` for
clarity:

```
v1\nPOST\n/v1/messages:batch\n\napi.sms-gateway.example\n018f3c2a-9b4d-7e21-a456-426614174000\n1794995160\n8745a7b3b4b4b1fd81d08106e22e2d6261a203d0fc673b7cbf4aa7fbdeee4ea9\nV1nQe4r0sK8mP2yL6dF9TQ
```

### Frozen signature

IEEE P1363, unpadded base64url:

```
dzk2otghSLa69_4gd_jzCjHEzSXl5lUoJRXd5OmXEPamGBcoTIklHuRNTyatMjYv5_ar0fXNwucc9h9Ox189uQ
```

**ECDSA signatures are non-deterministic.** A second sign of the same
canonical string will almost certainly produce different bytes and
still be valid. Implementations MUST assert

```
verify(publicKey, SHA-256, canonicalString, signature) === true
```

and MUST NOT assert byte equality with this frozen signature. The
frozen value is a verification vector (public key + canonical string +
signature that must verify), not a golden output of `sign()`.

The generator also produces a fresh signature on each run and checks
that it verifies, and that flipping `v1` to `v2` in the canonical
string causes verification to fail.

### Canonical HOST with a port (dev mock)

The primary vector above is unchanged. A second, additive vector in
`test-vector.json` (`devHostVector`) uses the same key, body, and
headers except `Host: 10.0.2.2:4010`. The canonical `HOST` field is
exactly `10.0.2.2:4010` (lowercased, port kept). Shown with `\n`:

```
v1\nPOST\n/v1/messages:batch\n\n10.0.2.2:4010\n018f3c2a-9b4d-7e21-a456-426614174000\n1794995160\n8745a7b3b4b4b1fd81d08106e22e2d6261a203d0fc673b7cbf4aa7fbdeee4ea9\nV1nQe4r0sK8mP2yL6dF9TQ
```

The frozen signature for that vector is in `devHostVector` and is
verified by the same generator script.

## Android notes

1. Generate the key in Keystore: `KeyProperties.KEY_ALGORITHM_EC`,
   `ECGenParameterSpec("secp256r1")`, `PURPOSE_SIGN`,
   `DIGEST_SHA256`, `setUserAuthenticationRequired(false)` (the app
   must be able to sign in the background). StrongBox if available.
2. Sign with `SHA256withECDSAinP1363Format` over the canonical string
   bytes (the `Signature` object hashes with SHA-256; do not pre-hash).
3. Export the public key at pairing with `publicKey.encoded` and
   base64url-encode it (no padding).
4. Hash and send the request body as the exact bytes on the wire; do
   not re-serialise and do not set `Content-Encoding`.
5. Use a trusted clock source. On `invalid_timestamp`, read `Date`
   and/or `server_time`, compute an offset, then resign with a new
   timestamp and nonce. Do not retry the same headers.
6. Contract floor for this scheme: API 23. The app's minSdk is 26.
7. On `401 device_unknown` or `403 device_revoked`, clear the stored
   credential and prompt re-pairing. `GET /v1/devices/me` is the
   exception for revoked devices: it still returns `200` and
   `status: revoked` after a valid signature.

## Backend verification order

1. Reject if body length > 1 MiB (`413 payload_too_large`) before
   parsing JSON.
2. Check required headers and `HOST` (must be an allowed backend
   host). Reject a request `Content-Encoding` header with
   `400 invalid_request`.
3. Compare `X-Content-SHA256` to SHA-256 of the raw body bytes
   received on the wire.
4. Check timestamp window. On failure return `401 invalid_timestamp`
   with a `Date` header and `server_time` in the body.
5. If `X-Device-Id` is present and the device is unknown or deleted,
   return `401 device_unknown` (`retryable: false`) **before**
   signature verification. (See the security note below.)
6. Check replay cache for nonce and signature.
7. Resolve the public key (pairing: from the body; otherwise from the
   credential for `X-Device-Id`).
8. Verify the signature over the canonical string.
9. For write endpoints, reject revoked devices with `403 device_revoked`.
   `GET /v1/devices/me` is allowed for revoked devices and returns
   `200` + `status: revoked`.
10. Record nonce and signature in the replay cache, then process.

### Security note on `device_unknown`

Returning `device_unknown` before signature verification discloses
that a given `X-Device-Id` is not a registered (or is a deleted)
device. This is unavoidable: there is no public key with which to
verify a signature for an unknown id, so the server cannot honestly
answer `invalid_signature` instead. Device ids are server-issued
UUIDs, so opportunistic enumeration is not practical beyond this
unavoidable existence leak. Do not return different timings or
details that would make probing easier.
