import { z } from "zod";
import { DEFAULT_CLAIM_MAPPING, type ClaimMapping } from "./claims.js";
import type { MfaClaimsMissing, MfaPolicy } from "./mfa.js";

const boolFromEnv = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", "yes", "no"])])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    return v === "true" || v === "1" || v === "yes";
  });

const oidcEnvSchema = z.object({
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  OIDC_SCOPES: z.string().default("openid profile email"),
  OIDC_CLAIM_EMAIL: z.string().min(1).default(DEFAULT_CLAIM_MAPPING.email),
  OIDC_CLAIM_NAME: z.string().min(1).default(DEFAULT_CLAIM_MAPPING.name),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_POST_LOGOUT_REDIRECT_URI: z.string().url().optional().or(z.literal("")),
  /** Expected JWT `aud` for bearer tokens. Defaults to OIDC_CLIENT_ID when unset. */
  OIDC_AUDIENCE: z.string().min(1).optional(),
  /** Comma-separated allowed signing algs for bearer JWTs. */
  OIDC_ALLOWED_ALGS: z.string().default("RS256,ES256"),
  REQUIRE_MFA: boolFromEnv.optional(),
  MFA_CLAIMS_MISSING: z.enum(["allow", "deny"]).optional(),
  /** Dangerous: link a new IdP identity to an existing user by email. Default off. */
  AUTO_LINK_BY_EMAIL: boolFromEnv.default(false),
  SESSION_COOKIE_NAME: z.string().min(1).default("sms_session"),
  CSRF_COOKIE_NAME: z.string().min(1).default("sms_csrf"),
  OAUTH_STATE_COOKIE_NAME: z.string().min(1).default("sms_oauth"),
  SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(60 * 60 * 24 * 7),
  /** Used to seal short-lived OAuth dance cookies (PKCE verifier/state/nonce). */
  SESSION_SECRET: z.string().min(32).optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** Allow HTTP discovery against local IdPs (Authentik compose). Never in production. */
  OIDC_ALLOW_INSECURE: boolFromEnv.default(false),
});

export type OidcAuthConfig = {
  enabled: boolean;
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  claimMapping: ClaimMapping;
  redirectUri: string;
  postLogoutRedirectUri: string | null;
  audience: string;
  allowedAlgs: string[];
  mfa: MfaPolicy;
  autoLinkByEmail: boolean;
  sessionCookieName: string;
  csrfCookieName: string;
  oauthStateCookieName: string;
  sessionTtlSeconds: number;
  sessionSecret: string;
  publicBaseUrl: string | null;
  allowInsecure: boolean;
  /** Populated from CORS_ALLOWED_ORIGINS when set; used for CSRF Origin checks. */
  corsAllowedOrigins: string[];
};

export type LoadOidcAuthConfigOptions = {
  nodeEnv: "development" | "test" | "production";
};

/**
 * Load OIDC auth settings. When `OIDC_ISSUER_URL` is unset, auth is disabled
 * (health endpoints still work). When the issuer is set, every required field
 * must be present or startup fails with a clear error.
 */
export function loadOidcAuthConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadOidcAuthConfigOptions = { nodeEnv: "development" },
): OidcAuthConfig | null {
  const parsed = oidcEnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid OIDC configuration: ${details}`);
  }

  const data = parsed.data;
  if (!data.OIDC_ISSUER_URL) {
    return null;
  }

  const missing: string[] = [];
  if (!data.OIDC_CLIENT_ID) missing.push("OIDC_CLIENT_ID");
  if (!data.OIDC_CLIENT_SECRET) missing.push("OIDC_CLIENT_SECRET");
  if (!data.OIDC_REDIRECT_URI) missing.push("OIDC_REDIRECT_URI");
  if (!data.SESSION_SECRET) missing.push("SESSION_SECRET");

  if (missing.length > 0) {
    throw new Error(
      `Invalid OIDC configuration: OIDC_ISSUER_URL is set but missing required: ${missing.join(", ")}`,
    );
  }

  if (options.nodeEnv === "production" && data.OIDC_ALLOW_INSECURE) {
    throw new Error(
      "Invalid OIDC configuration: OIDC_ALLOW_INSECURE must not be true in production",
    );
  }

  const requireMfa = data.REQUIRE_MFA ?? (options.nodeEnv === "production" ? true : false);
  const claimsMissing: MfaClaimsMissing =
    data.MFA_CLAIMS_MISSING ?? (requireMfa ? "deny" : "allow");

  const allowedAlgs = data.OIDC_ALLOWED_ALGS.split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (allowedAlgs.length === 0) {
    throw new Error("Invalid OIDC configuration: OIDC_ALLOWED_ALGS is empty");
  }

  return {
    enabled: true,
    issuerUrl: data.OIDC_ISSUER_URL,
    clientId: data.OIDC_CLIENT_ID!,
    clientSecret: data.OIDC_CLIENT_SECRET!,
    scopes: data.OIDC_SCOPES,
    claimMapping: {
      email: data.OIDC_CLAIM_EMAIL,
      name: data.OIDC_CLAIM_NAME,
    },
    redirectUri: data.OIDC_REDIRECT_URI!,
    postLogoutRedirectUri: data.OIDC_POST_LOGOUT_REDIRECT_URI || null,
    audience: data.OIDC_AUDIENCE ?? data.OIDC_CLIENT_ID!,
    allowedAlgs,
    mfa: { requireMfa, claimsMissing },
    autoLinkByEmail: data.AUTO_LINK_BY_EMAIL,
    sessionCookieName: data.SESSION_COOKIE_NAME,
    csrfCookieName: data.CSRF_COOKIE_NAME,
    oauthStateCookieName: data.OAUTH_STATE_COOKIE_NAME,
    sessionTtlSeconds: data.SESSION_TTL_SECONDS,
    sessionSecret: data.SESSION_SECRET!,
    publicBaseUrl: data.PUBLIC_BASE_URL ?? null,
    allowInsecure: data.OIDC_ALLOW_INSECURE,
    corsAllowedOrigins: [],
  };
}
