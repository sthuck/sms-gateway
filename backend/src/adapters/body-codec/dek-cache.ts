/**
 * In-process cache of unwrapped DEKs. Short TTL + size cap.
 * Never log or persist cache contents.
 */
export type DekCacheOptions = {
  ttlMs: number;
  maxEntries: number;
  /** Injectable clock for TTL tests. */
  now?: () => number;
};

type CacheEntry = {
  dek: Buffer;
  expiresAt: number;
};

export class DekCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly map = new Map<string, CacheEntry>();

  constructor(options: DekCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
    this.now = options.now ?? Date.now;
  }

  private key(ownerId: string, dekVersion: number): string {
    return `${ownerId}:${dekVersion}`;
  }

  get(ownerId: string, dekVersion: number): Buffer | null {
    const k = this.key(ownerId, dekVersion);
    const entry = this.map.get(k);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(k);
      return null;
    }
    // Refresh LRU order.
    this.map.delete(k);
    this.map.set(k, entry);
    return Buffer.from(entry.dek);
  }

  set(ownerId: string, dekVersion: number, dek: Uint8Array): void {
    const k = this.key(ownerId, dekVersion);
    this.map.delete(k);
    this.map.set(k, {
      dek: Buffer.from(dek),
      expiresAt: this.now() + this.ttlMs,
    });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  invalidate(ownerId: string, dekVersion?: number): void {
    if (dekVersion !== undefined) {
      this.map.delete(this.key(ownerId, dekVersion));
      return;
    }
    const prefix = `${ownerId}:`;
    for (const k of [...this.map.keys()]) {
      if (k.startsWith(prefix)) this.map.delete(k);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
