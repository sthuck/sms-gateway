import { describe, expect, it } from "vitest";
import { IngestMessageBatch } from "../../src/application/use-cases/ingest-message-batch.js";
import { InfrastructureError } from "../../src/domain/errors.js";
import { formatPhoneSender } from "../../src/adapters/phone/index.js";
import {
  MemoryBodyCodec,
  MemoryIngestRateLimiter,
  MemoryMessageRepository,
} from "./fakes/memory-ports.js";

const OWNER = "00000000-0000-4000-8000-000000000001";
const DEVICE = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-11-18T12:00:00Z");

function msg(
  id: string,
  overrides: Partial<{
    sender: string;
    body: string;
    received_at: string;
    sim_slot: number | null;
    direction: string;
    owner_id: string;
    device_id: string;
  }> = {},
) {
  return {
    device_msg_id: id,
    sender: overrides.sender ?? "+15551234567",
    body: overrides.body ?? "hello",
    received_at: overrides.received_at ?? "2026-11-18T09:45:12Z",
    sim_slot: overrides.sim_slot === undefined ? 0 : overrides.sim_slot,
    direction: overrides.direction ?? "inbound",
    ...(overrides.owner_id !== undefined ? { owner_id: overrides.owner_id } : {}),
    ...(overrides.device_id !== undefined ? { device_id: overrides.device_id } : {}),
  };
}

function buildUseCase(opts?: {
  messages?: MemoryMessageRepository;
  rateLimiter?: MemoryIngestRateLimiter;
}) {
  const messages = opts?.messages ?? new MemoryMessageRepository();
  const rateLimiter = opts?.rateLimiter ?? new MemoryIngestRateLimiter();
  return {
    messages,
    rateLimiter,
    useCase: new IngestMessageBatch({
      messages,
      rateLimiter,
      bodyCodec: new MemoryBodyCodec(),
      formatPhone: formatPhoneSender,
      defaultPhoneRegion: "US",
    }),
  };
}

describe("IngestMessageBatch use case", () => {
  it("stores valid items and marks resends as duplicates without extra publishes", async () => {
    const { useCase, messages } = buildUseCase();
    const batch = [msg("a"), msg("b")];

    const first = await useCase.execute({
      ownerId: OWNER,
      deviceId: DEVICE,
      rawMessages: batch,
      now: NOW,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.results.every((r) => r.status === "accepted")).toBe(true);
    expect(messages.published).toHaveLength(2);

    const second = await useCase.execute({
      ownerId: OWNER,
      deviceId: DEVICE,
      rawMessages: batch,
      now: NOW,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.results.every((r) => r.status === "duplicate")).toBe(true);
    expect(messages.published).toHaveLength(2);
    expect(messages.rows.size).toBe(2);
  });

  it("rejects invalid items individually without failing the batch", async () => {
    const { useCase, messages } = buildUseCase();
    const result = await useCase.execute({
      ownerId: OWNER,
      deviceId: DEVICE,
      rawMessages: [
        msg("ok-1"),
        {
          device_msg_id: "",
          sender: "+1",
          body: "x",
          received_at: "2026-11-18T09:45:12Z",
          direction: "inbound",
        },
        msg("ok-1"),
        msg("bad-dir", { direction: "sideways" }),
        msg("ok-2", { sender: "BankAlert" }),
        msg("national", { sender: "5551234567" }),
      ],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results[0]).toMatchObject({ device_msg_id: "ok-1", status: "accepted" });
    expect(result.results[1]).toMatchObject({
      status: "rejected",
      error: { code: "missing_field" },
    });
    expect(result.results[2]).toMatchObject({
      status: "rejected",
      error: { code: "duplicate_in_batch" },
    });
    expect(result.results[3]).toMatchObject({
      status: "rejected",
      error: { code: "invalid_field" },
    });
    expect(result.results[4]).toMatchObject({ device_msg_id: "ok-2", status: "accepted" });
    expect(result.results[5]).toMatchObject({ device_msg_id: "national", status: "accepted" });
    expect(messages.rows.get(`${DEVICE}:national`)?.message.sender).toBe("+15551234567");
    expect(messages.rows.get(`${DEVICE}:ok-2`)?.message.sender).toBe("BankAlert");
  });

  it("takes owner id only from credentials, never the payload", async () => {
    const { useCase, messages } = buildUseCase();
    const fakeOwner = "00000000-0000-4000-8000-000000000099";
    const result = await useCase.execute({
      ownerId: OWNER,
      deviceId: DEVICE,
      rawMessages: [msg("inject", { owner_id: fakeOwner, device_id: fakeOwner })],
      now: NOW,
    });
    expect(result.ok).toBe(true);
    const stored = messages.rows.get(`${DEVICE}:inject`);
    expect(stored?.ownerId).toBe(OWNER);
    expect(stored?.ownerId).not.toBe(fakeOwner);
  });

  it("returns rate_limited without writing when the request limiter denies", async () => {
    const rateLimiter = new MemoryIngestRateLimiter();
    rateLimiter.allow = false;
    const { useCase, messages } = buildUseCase({ rateLimiter });
    const result = await useCase.execute({
      ownerId: OWNER,
      deviceId: DEVICE,
      rawMessages: [msg("r1")],
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("rate_limited");
    expect(messages.rows.size).toBe(0);
  });

  it("propagates InfrastructureError from the repository (never as 4xx domain)", async () => {
    const messages = new MemoryMessageRepository();
    messages.fault.throwInfra = true;
    const { useCase } = buildUseCase({ messages });
    await expect(
      useCase.execute({
        ownerId: OWNER,
        deviceId: DEVICE,
        rawMessages: [msg("infra")],
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(InfrastructureError);
  });
});
