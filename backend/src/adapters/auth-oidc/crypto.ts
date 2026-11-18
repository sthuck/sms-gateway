import { createHash, randomBytes } from "node:crypto";
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

export const systemClock: Clock = {
  now: () => new Date(),
};

export const systemIdGenerator: IdGenerator = {
  uuid: () => randomUUID(),
  randomToken,
};

export const sha256TokenHasher: TokenHasher = {
  hash: sha256Hex,
};
