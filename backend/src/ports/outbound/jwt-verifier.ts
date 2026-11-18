export type VerifiedBearer = {
  payload: Record<string, unknown>;
  sub: string;
  iss: string;
};

/**
 * Verifies a bearer access token (JWKS).
 *
 * - Invalid/expired/wrong-aud tokens: throw a non-`InfrastructureError`
 *   (mapped to 401 by ResolveBearer — matches main).
 * - JWKS fetch / network / timeout: throw `InfrastructureError` → 5xx.
 */
export interface JwtVerifier {
  verify(token: string): Promise<VerifiedBearer>;
}
