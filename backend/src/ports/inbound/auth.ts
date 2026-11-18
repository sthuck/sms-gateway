import type { AuthMethod, User } from "../../domain/auth/types.js";

export type StartLoginResult = {
  redirectUrl: string;
  sealedState: string;
};

export type CompleteLoginInput = {
  callbackUrl: URL;
  sealedState: string;
};

export type CompleteLoginResult = {
  sessionId: string;
  csrfToken: string;
  expiresAt: Date;
  ownerId: string;
  redirectTo: string;
};

export type LogoutInput = {
  sessionId: string | undefined;
};

export type GetMeInput = {
  ownerId: string;
  authMethod: AuthMethod;
};

export type GetMeResult = User & {
  authMethod: AuthMethod;
};

export type ResolveSessionInput = {
  sessionId: string;
};

export type ResolveSessionResult = {
  ownerId: string;
  sessionRowId: string;
  csrfTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type ResolveBearerInput = {
  token: string;
};

export type ResolveBearerResult = {
  ownerId: string;
};
