import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient } from "./client";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createApiClient", () => {
  it("includes credentials and parses JSON success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "u1", email: "a@b.c", mfa_enrolled: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = createApiClient({ fetchImpl, getCsrfToken: () => null });
    const me = await client.get<{ id: string }>("/v1/auth/me");
    expect(me.id).toBe("u1");
    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/auth/me",
      expect.objectContaining({
        method: "GET",
        credentials: "include",
      }),
    );
  });

  it("sends CSRF header on unsafe methods", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: "AAAA-BBBB" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    const client = createApiClient({
      fetchImpl,
      getCsrfToken: () => "csrf-token",
    });
    await client.post("/v1/pairing-codes");

    expect(fetchImpl).toHaveBeenCalledWith(
      "/v1/pairing-codes",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-CSRF-Token": "csrf-token",
        }),
      }),
    );
  });

  it("redirects via onUnauthorized on 401 unauthorized", async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "unauthorized",
          title: "Unauthorized",
          detail: "Missing or invalid access token",
          status: 401,
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );

    const client = createApiClient({ fetchImpl, onUnauthorized, getCsrfToken: () => null });

    await expect(client.get("/v1/auth/me")).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("does not treat mfa_required as a login redirect", async () => {
    const onUnauthorized = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "mfa_required",
          title: "Multi-factor authentication required",
          detail: "MFA required",
          status: 401,
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );

    const client = createApiClient({ fetchImpl, onUnauthorized, getCsrfToken: () => null });

    try {
      await client.post("/v1/pairing-codes");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("mfa_required");
    }
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
