# ADR 0002: Search over encrypted message bodies

## Status

Accepted (STH-20)

## Context

Message bodies are envelope-encrypted at rest (per-user DEK). Product search
and stream rule evaluation need to match on body text. Options considered:

1. **Server-side decrypt-then-filter** over an owner-scoped, bounded candidate set.
2. **Blind keyword index** (HMAC/tokenized) stored beside ciphertext.

## Decision

Use **server-side decrypt-then-filter**, always scoped to the authenticated
owner and bounded by a window or limit.

- Sender, timestamp, device id, and SIM slot remain **plaintext metadata** so
  SQL can narrow the candidate set before any decrypt.
- Stream rules / preview already decrypt only the messages they evaluate.
- **No blind index** for now.

## Consequences

- Search cost scales with the narrowed candidate set, not the full corpus.
- No frequency leakage from a keyword index; lower storage/write cost.
- If search over large personal histories becomes slow, revisit a blind index
  (or other retrieval aids) with an explicit privacy trade-off review.
