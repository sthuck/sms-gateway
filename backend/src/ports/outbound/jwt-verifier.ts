export type VerifiedBearer = {
  payload: Record<string, unknown>;
  sub: string;
  iss: string;
};

export interface JwtVerifier {
  verify(token: string): Promise<VerifiedBearer>;
}
