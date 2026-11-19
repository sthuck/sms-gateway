export interface TokenHasher {
  hash(value: string): string;
  /** Constant-time equality for hex/utf8 digests of equal length. */
  safeEqual(a: string, b: string): boolean;
}
