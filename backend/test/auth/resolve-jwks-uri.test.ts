import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveJwksUri } from "../../src/adapters/auth-oidc/jwt.js";

function stubDiscovery(jwksUri: string) {
  const fetchMock = vi.fn(
    async (_input: string | URL | Request) =>
      new Response(JSON.stringify({ jwks_uri: jwksUri }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedUrl(fetchMock: ReturnType<typeof stubDiscovery>): string {
  return String(fetchMock.mock.calls[0]![0]);
}

describe("resolveJwksUri", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the issuer path (Authentik per-provider issuer)", async () => {
    const fetchMock = stubDiscovery("https://auth.example/application/o/sms-gateway/jwks/");

    const jwks = await resolveJwksUri("https://auth.example/application/o/sms-gateway/", false);

    expect(requestedUrl(fetchMock)).toBe(
      "https://auth.example/application/o/sms-gateway/.well-known/openid-configuration",
    );
    expect(jwks).toBe("https://auth.example/application/o/sms-gateway/jwks/");
  });

  it("adds the missing trailing slash before resolving", async () => {
    const fetchMock = stubDiscovery("https://auth.example/realms/main/certs");

    await resolveJwksUri("https://auth.example/realms/main", false);

    expect(requestedUrl(fetchMock)).toBe(
      "https://auth.example/realms/main/.well-known/openid-configuration",
    );
  });

  it("works for an issuer at the origin root", async () => {
    const fetchMock = stubDiscovery("https://idp.example/jwks");

    await resolveJwksUri("https://idp.example/", false);

    expect(requestedUrl(fetchMock)).toBe("https://idp.example/.well-known/openid-configuration");
  });

  it("refuses plain HTTP unless insecure discovery is allowed", async () => {
    const fetchMock = stubDiscovery("http://127.0.0.1:9000/jwks");

    await expect(resolveJwksUri("http://127.0.0.1:9000/application/o/x/", false)).rejects.toThrow(
      /Refusing HTTP JWKS discovery/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
