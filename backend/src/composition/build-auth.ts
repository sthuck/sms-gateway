import type { Pool } from "pg";
import type { AccessHeadersMap } from "../domain/access-headers.js";
import {
  CompleteLogin,
  CreateOwnerAccessToken,
  GetMe,
  ListOwnerAccessTokens,
  Logout,
  ResolveBearer,
  ResolveOwnerPat,
  ResolveSession,
  RevokeOwnerAccessToken,
  StartLogin,
} from "../application/use-cases/index.js";
import type { AuthUseCases } from "../adapters/http-fastify/auth-plugin.js";
import {
  createJwtVerifier,
  createOidcClient,
  OpenIdClientOidcProvider,
  resolveJwksUri,
  sha256TokenHasher,
  systemClock,
  systemIdGenerator,
  type OidcAuthConfig,
} from "../adapters/auth-oidc/index.js";
import {
  PgAuditRepository,
  PgIdentityRepository,
  PgOwnerAccessTokenRepository,
  PgSessionRepository,
  PgUserRepository,
} from "../adapters/db-postgres/index.js";
import type { JwtVerifier } from "../ports/outbound/jwt-verifier.js";
import type { OidcProvider } from "../ports/outbound/oidc-provider.js";

export type BuildAuthStackOptions = {
  config: OidcAuthConfig | null;
  pool: Pool | null;
  /** Inject a pre-built JWT verifier (tests). */
  jwtVerifier?: JwtVerifier | null | undefined;
  /** Inject a pre-built OIDC provider (tests). */
  oidcProvider?: OidcProvider | null | undefined;
  /** Skip remote discovery (tests supply jwtVerifier + stub oidc). */
  skipDiscovery?: boolean | undefined;
  /** Optional access headers (e.g. Cloudflare Access) returned on PAT creation. */
  agentAccessHeaders?: AccessHeadersMap | null | undefined;
};

export type AuthStack = {
  config: OidcAuthConfig | null;
  oidcProvider: OidcProvider | null;
  jwtVerifier: JwtVerifier | null;
  useCases: AuthUseCases | null;
};

function buildTokenUseCases(
  pool: Pool | null,
  agentAccessHeaders: AccessHeadersMap | null,
): Pick<
  AuthUseCases,
  "resolveOwnerPat" | "createOwnerAccessToken" | "listOwnerAccessTokens" | "revokeOwnerAccessToken"
> {
  if (!pool) {
    return {
      resolveOwnerPat: null,
      createOwnerAccessToken: null,
      listOwnerAccessTokens: null,
      revokeOwnerAccessToken: null,
    };
  }
  const ownerTokens = new PgOwnerAccessTokenRepository(pool);
  const audit = new PgAuditRepository(pool);
  const ids = systemIdGenerator;
  const hasher = sha256TokenHasher;
  return {
    resolveOwnerPat: new ResolveOwnerPat({ tokens: ownerTokens, hasher }),
    createOwnerAccessToken: new CreateOwnerAccessToken({
      tokens: ownerTokens,
      audit,
      ids,
      hasher,
      agentAccessHeaders,
    }),
    listOwnerAccessTokens: new ListOwnerAccessTokens({ tokens: ownerTokens }),
    revokeOwnerAccessToken: new RevokeOwnerAccessToken({ tokens: ownerTokens, audit }),
  };
}

export async function buildAuthStack(options: BuildAuthStackOptions): Promise<AuthStack> {
  const { config, pool } = options;
  const tokenUseCases = buildTokenUseCases(pool, options.agentAccessHeaders ?? null);

  if (!config) {
    // PAT stack can still run when OIDC is off but a pool is present.
    if (!pool) {
      return {
        config: null,
        oidcProvider: null,
        jwtVerifier: null,
        useCases: null,
      };
    }
    return {
      config: null,
      oidcProvider: null,
      jwtVerifier: null,
      useCases: {
        startLogin: null,
        completeLogin: null,
        logout: null,
        getMe: null,
        resolveSession: null,
        resolveBearer: null,
        ...tokenUseCases,
      },
    };
  }

  let oidcProvider = options.oidcProvider ?? null;
  let jwtVerifier = options.jwtVerifier ?? null;

  if (!options.skipDiscovery) {
    if (!oidcProvider) {
      const handle = await createOidcClient(config);
      oidcProvider = new OpenIdClientOidcProvider(handle);
    }
    if (!jwtVerifier) {
      const jwksUri = await resolveJwksUri(config.issuerUrl, config.allowInsecure);
      jwtVerifier = createJwtVerifier(config, jwksUri);
    }
  }

  // Login only needs OIDC (main: 302 with config+oidc even when pool is null).
  const startLogin = oidcProvider ? new StartLogin({ oidc: oidcProvider }) : null;

  if (!pool || !oidcProvider || !jwtVerifier) {
    return {
      config,
      oidcProvider,
      jwtVerifier,
      useCases: {
        startLogin,
        completeLogin: null,
        logout: null,
        getMe: null,
        resolveSession: null,
        resolveBearer: null,
        ...tokenUseCases,
      },
    };
  }

  const identities = new PgIdentityRepository(pool);
  const users = new PgUserRepository(pool);
  const sessions = new PgSessionRepository(pool);
  const ids = systemIdGenerator;
  const hasher = sha256TokenHasher;
  const clock = systemClock;

  const useCases: AuthUseCases = {
    startLogin,
    completeLogin: new CompleteLogin({
      oidc: oidcProvider,
      identities,
      users,
      sessions,
      ids,
      hasher,
      clock,
      config: {
        autoLinkByEmail: config.autoLinkByEmail,
        sessionTtlSeconds: config.sessionTtlSeconds,
        publicBaseUrl: config.publicBaseUrl,
      },
    }),
    logout: new Logout({ sessions, hasher, clock }),
    getMe: new GetMe({ users }),
    resolveSession: new ResolveSession({ sessions, hasher, clock }),
    resolveBearer: new ResolveBearer({
      jwt: jwtVerifier,
      identities,
      mfa: config.mfa,
    }),
    ...tokenUseCases,
  };

  return { config, oidcProvider, jwtVerifier, useCases };
}
