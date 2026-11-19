import { describe, expect, it } from "vitest";
import { CreateOwnerAccessToken, IssuePairingCode } from "../../src/application/use-cases/index.js";
import { decodeAccessHeadersParam } from "../../src/domain/access-headers.js";
import type { OwnerAccessToken } from "../../src/domain/auth/access-token.js";
import type {
  AppendAuditInput,
  AuditRepository,
} from "../../src/ports/outbound/audit-repository.js";
import type {
  InsertOwnerAccessTokenInput,
  OwnerAccessTokenRepository,
} from "../../src/ports/outbound/owner-access-token-repository.js";
import {
  MemoryIdGenerator,
  MemoryPairingCodeRepository,
  MemoryTokenHasher,
} from "./fakes/memory-ports.js";

class MemoryOwnerAccessTokenRepo implements OwnerAccessTokenRepository {
  readonly rows: InsertOwnerAccessTokenInput[] = [];
  async insert(input: InsertOwnerAccessTokenInput): Promise<void> {
    this.rows.push(input);
  }
  async list(): Promise<OwnerAccessToken[]> {
    return [];
  }
  async revoke(): Promise<"missing" | "revoked" | "already_revoked"> {
    return "missing";
  }
  async lookupById() {
    return null;
  }
  async touchLastUsed(): Promise<void> {}
}

class MemoryAuditRepo implements AuditRepository {
  readonly events: AppendAuditInput[] = [];
  async append(input: AppendAuditInput): Promise<void> {
    this.events.push(input);
  }
}

describe("IssuePairingCode with access headers", () => {
  it("omits headers param and sets hasAccessHeaders=false when unconfigured", async () => {
    const useCase = new IssuePairingCode({
      pairingCodes: new MemoryPairingCodeRepository(),
      generateCode: () => "7K3M-9Q2P",
      normalizeCode: (raw) => raw.replace(/-/g, ""),
      hashCode: (norm) => `hash(${norm})`,
      ttlSeconds: 300,
      apiPublicUrl: "https://sms.example",
      deviceAccessHeaders: null,
    });

    const result = await useCase.execute({ ownerId: "owner-1" });
    expect(result.hasAccessHeaders).toBe(false);
    expect(result.qrPayload).toBe("smsgw://pair?code=7K3M-9Q2P&server=https%3A%2F%2Fsms.example");
    expect(new URL(result.qrPayload).searchParams.get("headers")).toBeNull();
  });

  it("embeds base64url headers param and sets hasAccessHeaders=true when configured", async () => {
    const deviceHeaders = {
      "CF-Access-Client-Id": "dev-id.access",
      "CF-Access-Client-Secret": "dev-secret",
    };
    const useCase = new IssuePairingCode({
      pairingCodes: new MemoryPairingCodeRepository(),
      generateCode: () => "7K3M-9Q2P",
      normalizeCode: (raw) => raw.replace(/-/g, ""),
      hashCode: (norm) => `hash(${norm})`,
      ttlSeconds: 300,
      apiPublicUrl: "https://sms.example",
      deviceAccessHeaders: deviceHeaders,
    });

    const result = await useCase.execute({ ownerId: "owner-1" });
    expect(result.hasAccessHeaders).toBe(true);
    const parsed = new URL(result.qrPayload);
    expect(parsed.searchParams.get("code")).toBe("7K3M-9Q2P");
    expect(parsed.searchParams.get("server")).toBe("https://sms.example");
    expect(decodeAccessHeadersParam(parsed.searchParams.get("headers")!)).toEqual(deviceHeaders);
  });
});

describe("CreateOwnerAccessToken with access headers", () => {
  it("omits accessHeaders when unconfigured", async () => {
    const tokens = new MemoryOwnerAccessTokenRepo();
    const audit = new MemoryAuditRepo();
    const useCase = new CreateOwnerAccessToken({
      tokens,
      audit,
      ids: new MemoryIdGenerator(),
      hasher: new MemoryTokenHasher(),
      agentAccessHeaders: null,
    });

    const result = await useCase.execute({ ownerId: "owner-1", name: "script" });
    expect("accessHeaders" in result).toBe(false);
    expect(result.accessHeaders).toBeUndefined();
    expect(audit.events).toHaveLength(1);
  });

  it("returns accessHeaders copy when configured", async () => {
    const agentHeaders = {
      "CF-Access-Client-Id": "agent-id.access",
      "CF-Access-Client-Secret": "agent-secret",
    };
    const useCase = new CreateOwnerAccessToken({
      tokens: new MemoryOwnerAccessTokenRepo(),
      audit: new MemoryAuditRepo(),
      ids: new MemoryIdGenerator(),
      hasher: new MemoryTokenHasher(),
      agentAccessHeaders: agentHeaders,
    });

    const result = await useCase.execute({ ownerId: "owner-1", name: "script" });
    expect(result.accessHeaders).toEqual(agentHeaders);
    expect(result.accessHeaders).not.toBe(agentHeaders);
  });
});
