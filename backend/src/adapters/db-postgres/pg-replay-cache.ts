import type { Pool } from "pg";
import type { ReplayCache } from "../../ports/outbound/replay-cache.js";
import { claimNonceAndSignature } from "./replay-cache.js";

export class PgReplayCache implements ReplayCache {
  constructor(private readonly pool: Pool) {}

  claimNonceAndSignature(
    identity: string,
    nonce: string,
    signature: string,
    ttlSeconds?: number,
  ): Promise<"ok" | "replay"> {
    return claimNonceAndSignature(this.pool, identity, nonce, signature, ttlSeconds);
  }
}
