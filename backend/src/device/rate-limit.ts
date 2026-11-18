import type { Pool } from "pg";

export type RateLimitConfig = {
  /** Max pair attempts per source IP per window. Default 10. */
  pairPerIpLimit: number;
  /** Window length in seconds for per-IP limit. Default 60. */
  pairPerIpWindowSec: number;
  /** Max invalid-code attempts globally per window. Default 120. */
  pairGlobalInvalidLimit: number;
  /** Window for global invalid-code counter. Default 60. */
  pairGlobalInvalidWindowSec: number;
  /** Consecutive invalid codes from one IP before lock. Default 20. */
  pairIpInvalidLockThreshold: number;
  /** Lock duration in seconds after threshold. Default 900 (15 min). */
  pairIpInvalidLockSec: number;
};

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  pairPerIpLimit: 10,
  pairPerIpWindowSec: 60,
  pairGlobalInvalidLimit: 120,
  pairGlobalInvalidWindowSec: 60,
  pairIpInvalidLockThreshold: 20,
  pairIpInvalidLockSec: 900,
};

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window resets. */
  resetSec: number;
  /** Seconds to wait when denied (Retry-After). */
  retryAfterSec: number;
};

type BucketRow = {
  window_start: Date;
  hit_count: number;
  locked_until: Date | null;
};

/**
 * Postgres-backed fixed-window counters shared across instances.
 *
 * Chosen over an in-memory @fastify/rate-limit store so multi-replica
 * deploys share the same counters (in-memory would under-enforce). No
 * Redis in the stack yet; a small `app.rate_limit_buckets` table is enough.
 */
export async function consumeRateLimit(
  pool: Pool,
  bucketKey: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitDecision> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<BucketRow>(
      `SELECT window_start, hit_count, locked_until
       FROM app.rate_limit_buckets
       WHERE bucket_key = $1
       FOR UPDATE`,
      [bucketKey],
    );

    const now = new Date();
    let windowStart = now;
    let hitCount = 0;
    let lockedUntil: Date | null = null;

    if (rows[0]) {
      lockedUntil = rows[0].locked_until;
      const ageSec = (now.getTime() - rows[0].window_start.getTime()) / 1000;
      if (ageSec < windowSec) {
        windowStart = rows[0].window_start;
        hitCount = rows[0].hit_count;
      } else {
        lockedUntil = null;
      }
    }

    if (lockedUntil && lockedUntil > now) {
      const retryAfterSec = Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
      await client.query("COMMIT");
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetSec: retryAfterSec,
        retryAfterSec,
      };
    }

    const resetSec = Math.max(
      1,
      Math.ceil(windowSec - (now.getTime() - windowStart.getTime()) / 1000),
    );

    if (hitCount >= limit) {
      await client.query("COMMIT");
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetSec,
        retryAfterSec: resetSec,
      };
    }

    hitCount += 1;
    await client.query(
      `INSERT INTO app.rate_limit_buckets (bucket_key, window_start, hit_count, locked_until)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (bucket_key) DO UPDATE
         SET window_start = EXCLUDED.window_start,
             hit_count = EXCLUDED.hit_count`,
      [bucketKey, windowStart, hitCount],
    );
    await client.query("COMMIT");

    return {
      allowed: true,
      limit,
      remaining: Math.max(0, limit - hitCount),
      resetSec,
      retryAfterSec: 0,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}

async function readLock(
  pool: Pool,
  bucketKey: string,
): Promise<{ locked: boolean; retryAfterSec: number }> {
  const { rows } = await pool.query<{ locked_until: Date | null }>(
    `SELECT locked_until FROM app.rate_limit_buckets WHERE bucket_key = $1`,
    [bucketKey],
  );
  const until = rows[0]?.locked_until;
  if (until && until.getTime() > Date.now()) {
    return {
      locked: true,
      retryAfterSec: Math.max(1, Math.ceil((until.getTime() - Date.now()) / 1000)),
    };
  }
  return { locked: false, retryAfterSec: 0 };
}

export async function checkPairIpAllowed(
  pool: Pool,
  ip: string,
  config: RateLimitConfig,
): Promise<RateLimitDecision> {
  const lock = await readLock(pool, `pair:invalid-ip:${ip}`);
  if (lock.locked) {
    return {
      allowed: false,
      limit: config.pairPerIpLimit,
      remaining: 0,
      resetSec: lock.retryAfterSec,
      retryAfterSec: lock.retryAfterSec,
    };
  }

  return consumeRateLimit(pool, `pair:ip:${ip}`, config.pairPerIpLimit, config.pairPerIpWindowSec);
}

export async function checkPairGlobalInvalidAllowed(
  pool: Pool,
  config: RateLimitConfig,
): Promise<RateLimitDecision> {
  const { rows } = await pool.query<{ hit_count: number; window_start: Date }>(
    `SELECT hit_count, window_start FROM app.rate_limit_buckets WHERE bucket_key = $1`,
    ["pair:invalid-global"],
  );
  const row = rows[0];
  if (!row) {
    return {
      allowed: true,
      limit: config.pairGlobalInvalidLimit,
      remaining: config.pairGlobalInvalidLimit,
      resetSec: config.pairGlobalInvalidWindowSec,
      retryAfterSec: 0,
    };
  }
  const ageSec = (Date.now() - row.window_start.getTime()) / 1000;
  if (ageSec >= config.pairGlobalInvalidWindowSec) {
    return {
      allowed: true,
      limit: config.pairGlobalInvalidLimit,
      remaining: config.pairGlobalInvalidLimit,
      resetSec: config.pairGlobalInvalidWindowSec,
      retryAfterSec: 0,
    };
  }
  const resetSec = Math.max(1, Math.ceil(config.pairGlobalInvalidWindowSec - ageSec));
  if (row.hit_count >= config.pairGlobalInvalidLimit) {
    return {
      allowed: false,
      limit: config.pairGlobalInvalidLimit,
      remaining: 0,
      resetSec,
      retryAfterSec: resetSec,
    };
  }
  return {
    allowed: true,
    limit: config.pairGlobalInvalidLimit,
    remaining: Math.max(0, config.pairGlobalInvalidLimit - row.hit_count),
    resetSec,
    retryAfterSec: 0,
  };
}

/** Record an invalid pairing-code attempt; may lock the IP bucket. */
export async function noteInvalidPairingCode(
  pool: Pool,
  ip: string,
  config: RateLimitConfig,
): Promise<void> {
  await consumeRateLimit(
    pool,
    `pair:invalid-ip:${ip}`,
    Number.MAX_SAFE_INTEGER,
    config.pairGlobalInvalidWindowSec,
  );
  await consumeRateLimit(
    pool,
    "pair:invalid-global",
    Number.MAX_SAFE_INTEGER,
    config.pairGlobalInvalidWindowSec,
  );

  const { rows } = await pool.query<{ hit_count: number }>(
    `SELECT hit_count FROM app.rate_limit_buckets WHERE bucket_key = $1`,
    [`pair:invalid-ip:${ip}`],
  );
  if ((rows[0]?.hit_count ?? 0) >= config.pairIpInvalidLockThreshold) {
    await pool.query(
      `UPDATE app.rate_limit_buckets
       SET locked_until = now() + make_interval(secs => $2)
       WHERE bucket_key = $1`,
      [`pair:invalid-ip:${ip}`, config.pairIpInvalidLockSec],
    );
  }
}

export function rateLimitHeaders(decision: RateLimitDecision): Record<string, number> {
  return {
    "RateLimit-Limit": decision.limit,
    "RateLimit-Remaining": decision.remaining,
    "RateLimit-Reset": decision.resetSec,
  };
}
