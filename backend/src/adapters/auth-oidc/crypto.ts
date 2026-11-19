import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { Clock } from "../../ports/outbound/clock.js";
import type { IdGenerator } from "../../ports/outbound/id-generator.js";
import type { TokenHasher } from "../../ports/outbound/token-hasher.js";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqualUtf8(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const systemIdGenerator: IdGenerator = {
  uuid: () => randomUUID(),
  randomToken,
};

export const sha256TokenHasher: TokenHasher = {
  hash: sha256Hex,
  safeEqual: safeEqualUtf8,
};
