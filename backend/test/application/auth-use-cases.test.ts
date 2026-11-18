import { describe, expect, it } from "vitest";
import {
  CompleteLogin,
  GetMe,
  Logout,
  ResolveBearer,
  ResolveSession,
  StartLogin,
} from "../../src/application/use-cases/index.js";
import type { AuthError } from "../../src/domain/auth/errors.js";
import {
  MemoryClock,
  MemoryIdGenerator,
  MemoryIdentityRepository,
  MemorySessionRepository,
  MemoryTokenHasher,
  MemoryUserRepository,
  StubJwtVerifier,
  StubOidcProvider,
} from "./fakes/memory-ports.js";

function buildCompleteLogin(overrides?: { oidc?: StubOidcProvider; autoLinkByEmail?: boolean }) {
  const oidc = overrides?.oidc ?? new StubOidcProvider();
  const identities = new MemoryIdentityRepository();
  const users = new MemoryUserRepository(identities);
  const sessions = new MemorySessionRepository();
  const ids = new MemoryIdGenerator();
  const hasher = new MemoryTokenHasher();
  const clock = new MemoryClock();
  const useCase = new CompleteLogin({
    oidc,
    identities,
    users,
    sessions,
    ids,
    hasher,
    clock,
    config: {
      autoLinkByEmail: overrides?.autoLinkByEmail ?? false,
      sessionTtlSeconds: 3600,
      publicBaseUrl: "https://app.example/",
    },
  });
  return { useCase, oidc, identities, users, sessions, ids, hasher, clock };
}

describe("StartLogin", () => {
  it("returns redirect and sealed state from OIDC port", async () => {
    const oidc = new StubOidcProvider();
    const result = await new StartLogin({ oidc }).execute();
    expect(result.redirectUrl).toContain("https://idp.example");
    expect(result.sealedState).toBe("sealed");
  });
});

describe("CompleteLogin", () => {
  it("provisions a user and creates a session", async () => {
    const { useCase, identities, users, sessions, hasher } = buildCompleteLogin();
    const result = await useCase.execute({
      callbackUrl: new URL("https://app.example/v1/auth/callback?code=x&state=y"),
      sealedState: "sealed",
    });
    expect(result.ownerId).toMatch(/^00000000-/);
    expect(result.redirectTo).toBe("https://app.example/");
    expect(identities.rows).toHaveLength(1);
    expect(users.users.get(result.ownerId)?.email).toBe("a@example.com");
    expect(sessions.byHash.get(hasher.hash(result.sessionId))).toBeTruthy();
  });

  it("reuses an existing identity on second login", async () => {
    const ctx = buildCompleteLogin();
    const first = await ctx.useCase.execute({
      callbackUrl: new URL("https://app.example/cb"),
      sealedState: "s",
    });
    const second = await ctx.useCase.execute({
      callbackUrl: new URL("https://app.example/cb"),
      sealedState: "s",
    });
    expect(second.ownerId).toBe(first.ownerId);
    expect(ctx.identities.rows).toHaveLength(1);
    expect(ctx.users.users.size).toBe(1);
  });

  it("rejects invalid OAuth callback", async () => {
    const oidc = new StubOidcProvider();
    oidc.failFinish = new Error("bad state");
    const { useCase } = buildCompleteLogin({ oidc });
    await expect(
      useCase.execute({
        callbackUrl: new URL("https://app.example/cb"),
        sealedState: "nope",
      }),
    ).rejects.toMatchObject({ code: "invalid_callback" } satisfies Partial<AuthError>);
  });

  it("rejects when MFA is required but not satisfied", async () => {
    const oidc = new StubOidcProvider();
    oidc.setClaims({ sub: "x", email: "x@example.com", amr: ["pwd"] });
    const { useCase } = buildCompleteLogin({ oidc });
    await expect(
      useCase.execute({
        callbackUrl: new URL("https://app.example/cb"),
        sealedState: "s",
      }),
    ).rejects.toMatchObject({ code: "mfa_required" });
  });

  it("auto-links by email when enabled", async () => {
    const ctx = buildCompleteLogin({ autoLinkByEmail: true });
    ctx.users.users.set("existing-owner", {
      id: "existing-owner",
      email: "a@example.com",
      mfaEnrolled: false,
      displayName: "Old",
      lastAuthMethod: null,
    });
    const result = await ctx.useCase.execute({
      callbackUrl: new URL("https://app.example/cb"),
      sealedState: "s",
    });
    expect(result.ownerId).toBe("existing-owner");
    expect(ctx.identities.rows[0]?.sub).toBe("sub-1");
  });

  it("does not auto-link when disabled even if email matches", async () => {
    const ctx = buildCompleteLogin({ autoLinkByEmail: false });
    ctx.users.users.set("existing-owner", {
      id: "existing-owner",
      email: "a@example.com",
      mfaEnrolled: false,
      displayName: "Old",
      lastAuthMethod: null,
    });
    const result = await ctx.useCase.execute({
      callbackUrl: new URL("https://app.example/cb"),
      sealedState: "s",
    });
    expect(result.ownerId).not.toBe("existing-owner");
    expect(ctx.users.users.size).toBe(2);
  });

  it("honours session TTL from config via the clock", async () => {
    const ctx = buildCompleteLogin();
    const result = await ctx.useCase.execute({
      callbackUrl: new URL("https://app.example/cb"),
      sealedState: "s",
    });
    const stored = ctx.sessions.byHash.get(ctx.hasher.hash(result.sessionId))!;
    expect(stored.expiresAt.getTime() - ctx.clock.now().getTime()).toBe(3600_000);
  });

  it("stores hashed session id and CSRF token, not raw values", async () => {
    const ctx = buildCompleteLogin();
    const result = await ctx.useCase.execute({
      callbackUrl: new URL("https://app.example/cb"),
      sealedState: "s",
    });
    const keys = [...ctx.sessions.byHash.keys()];
    expect(keys).toEqual([ctx.hasher.hash(result.sessionId)]);
    expect(ctx.sessions.byHash.get(keys[0]!)!.csrfTokenHash).toBe(
      ctx.hasher.hash(result.csrfToken),
    );
    expect(keys[0]).not.toBe(result.sessionId);
  });

  it("updates profile on existing identity login", async () => {
    const ctx = buildCompleteLogin();
    await ctx.useCase.execute({
      callbackUrl: new URL("https://app.example/cb"),
      sealedState: "s",
    });
    ctx.oidc.setClaims({
      sub: "sub-1",
      email: "renamed@example.com",
      name: "Ada Lovelace",
      amr: ["pwd", "otp"],
    });
    const second = await ctx.useCase.execute({
      callbackUrl: new URL("https://app.example/cb"),
      sealedState: "s",
    });
    const user = ctx.users.users.get(second.ownerId)!;
    expect(user.email).toBe("renamed@example.com");
    expect(user.displayName).toBe("Ada Lovelace");
  });
});

describe("Logout", () => {
  it("revokes an active session and no-ops when missing", async () => {
    const sessions = new MemorySessionRepository();
    const hasher = new MemoryTokenHasher();
    const clock = new MemoryClock();
    await sessions.insert({
      ownerId: "o1",
      sessionIdHash: hasher.hash("sid"),
      csrfTokenHash: hasher.hash("csrf"),
      expiresAt: new Date(clock.now().getTime() + 60_000),
    });
    const logout = new Logout({ sessions, hasher, clock });
    await logout.execute({ sessionId: "sid" });
    expect(sessions.byHash.get(hasher.hash("sid"))?.revokedAt).toBeInstanceOf(Date);
    await logout.execute({ sessionId: undefined });
    await logout.execute({ sessionId: "unknown" });
  });
});

describe("GetMe", () => {
  it("returns the user or unauthorized", async () => {
    const users = new MemoryUserRepository();
    users.users.set("o1", {
      id: "o1",
      email: "a@example.com",
      mfaEnrolled: true,
      displayName: "Ada",
      lastAuthMethod: "otp",
    });
    const getMe = new GetMe({ users });
    const me = await getMe.execute({ ownerId: "o1", authMethod: "session" });
    expect(me.email).toBe("a@example.com");
    expect(me.authMethod).toBe("session");
    await expect(getMe.execute({ ownerId: "missing", authMethod: "bearer" })).rejects.toMatchObject(
      { code: "unauthorized" },
    );
  });
});

describe("ResolveSession", () => {
  it("resolves active sessions and rejects expired ones", async () => {
    const sessions = new MemorySessionRepository();
    const hasher = new MemoryTokenHasher();
    const clock = new MemoryClock();
    await sessions.insert({
      ownerId: "o1",
      sessionIdHash: hasher.hash("sid"),
      csrfTokenHash: hasher.hash("csrf"),
      expiresAt: new Date(clock.now().getTime() + 60_000),
    });
    const resolve = new ResolveSession({ sessions, hasher, clock });
    const ok = await resolve.execute({ sessionId: "sid" });
    expect(ok.ownerId).toBe("o1");
    expect(ok.expiresAt).toEqual(new Date(clock.now().getTime() + 60_000));
    // Touch must not happen here (CSRF runs first in the HTTP adapter).
    expect(sessions.touched).toEqual([]);

    clock.advanceMs(120_000);
    await expect(resolve.execute({ sessionId: "sid" })).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("rejects revoked sessions", async () => {
    const sessions = new MemorySessionRepository();
    const hasher = new MemoryTokenHasher();
    const clock = new MemoryClock();
    await sessions.insert({
      ownerId: "o1",
      sessionIdHash: hasher.hash("sid"),
      csrfTokenHash: hasher.hash("csrf"),
      expiresAt: new Date(clock.now().getTime() + 60_000),
    });
    await sessions.revokeBySessionIdHash("o1", hasher.hash("sid"));
    await expect(
      new ResolveSession({ sessions, hasher, clock }).execute({ sessionId: "sid" }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("ResolveBearer", () => {
  it("maps issuer/sub to owner and enforces MFA", async () => {
    const identities = new MemoryIdentityRepository();
    await identities.link("o1", "https://idp.example", "sub-1");
    const jwt = new StubJwtVerifier();
    jwt.next = {
      payload: { sub: "sub-1", amr: ["pwd", "otp"] },
      sub: "sub-1",
      iss: "https://idp.example",
    };
    const resolve = new ResolveBearer({
      jwt,
      identities,
      mfa: { requireMfa: true, claimsMissing: "deny" },
    });
    await expect(resolve.execute({ token: "t" })).resolves.toEqual({ ownerId: "o1" });

    jwt.next = {
      payload: { sub: "sub-1", amr: ["pwd"] },
      sub: "sub-1",
      iss: "https://idp.example",
    };
    await expect(resolve.execute({ token: "t" })).rejects.toMatchObject({ code: "mfa_required" });

    jwt.fail = new Error("bad");
    jwt.next = null;
    await expect(resolve.execute({ token: "t" })).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("rejects unknown issuer/sub", async () => {
    const identities = new MemoryIdentityRepository();
    const jwt = new StubJwtVerifier();
    jwt.next = {
      payload: { sub: "unknown", amr: ["pwd", "otp"] },
      sub: "unknown",
      iss: "https://idp.example",
    };
    await expect(
      new ResolveBearer({
        jwt,
        identities,
        mfa: { requireMfa: true, claimsMissing: "deny" },
      }).execute({ token: "t" }),
    ).rejects.toMatchObject({ code: "unauthorized", message: "Unknown identity" });
  });

  it("rethrows InfrastructureError from JWT verify (never maps to unauthorized)", async () => {
    const { InfrastructureError } = await import("../../src/domain/errors.js");
    const identities = new MemoryIdentityRepository();
    const jwt = new StubJwtVerifier();
    jwt.fail = new InfrastructureError("JWKS down");
    await expect(
      new ResolveBearer({
        jwt,
        identities,
        mfa: { requireMfa: true, claimsMissing: "deny" },
      }).execute({ token: "t" }),
    ).rejects.toBeInstanceOf(InfrastructureError);
  });

  it("rethrows InfrastructureError from identity lookup", async () => {
    const { InfrastructureError } = await import("../../src/domain/errors.js");
    const identities = new MemoryIdentityRepository();
    identities.fault.throwInfra = true;
    const jwt = new StubJwtVerifier();
    jwt.next = {
      payload: { sub: "sub-1", amr: ["pwd", "otp"] },
      sub: "sub-1",
      iss: "https://idp.example",
    };
    await expect(
      new ResolveBearer({
        jwt,
        identities,
        mfa: { requireMfa: true, claimsMissing: "deny" },
      }).execute({ token: "t" }),
    ).rejects.toBeInstanceOf(InfrastructureError);
  });
});
