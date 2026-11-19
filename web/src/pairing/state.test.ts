import { describe, expect, it } from "vitest";
import { deviceIdSet, initialPairingState, reducePairingState, secondsRemaining } from "./state";
import type { OwnerDevice, PairingCodeResponse } from "../api/types";

const issued: PairingCodeResponse = {
  code: "7K3M-9Q2P",
  qr_payload: "smsgw://pair?code=7K3M-9Q2P",
  expires_at: "2026-11-19T12:05:00.000Z",
  ttl_seconds: 300,
};

const deviceA: OwnerDevice = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Old Phone",
  status: "active",
  created_at: "2026-11-01T00:00:00.000Z",
  last_seen_at: null,
  revoked_at: null,
};

const deviceB: OwnerDevice = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "Google Pixel 8",
  status: "active",
  created_at: "2026-11-19T12:02:00.000Z",
  last_seen_at: null,
  revoked_at: null,
};

describe("reducePairingState", () => {
  it("idle -> requesting -> active with code", () => {
    let state = initialPairingState();
    expect(state.kind).toBe("idle");

    state = reducePairingState(state, { type: "REQUEST" });
    expect(state.kind).toBe("requesting");

    state = reducePairingState(state, {
      type: "ISSUED",
      response: issued,
      knownDeviceIds: deviceIdSet([deviceA]),
    });
    expect(state).toMatchObject({
      kind: "active",
      code: "7K3M-9Q2P",
      qrPayload: issued.qr_payload,
      expiresAt: Date.parse(issued.expires_at),
    });
  });

  it("active -> expired on tick past TTL", () => {
    let state = reducePairingState(initialPairingState(), {
      type: "ISSUED",
      response: issued,
      knownDeviceIds: new Set(),
    });
    const beforeExpiry = Date.parse(issued.expires_at) - 1000;
    state = reducePairingState(state, { type: "TICK", now: beforeExpiry });
    expect(state.kind).toBe("active");

    state = reducePairingState(state, {
      type: "TICK",
      now: Date.parse(issued.expires_at),
    });
    expect(state).toEqual({ kind: "expired", code: "7K3M-9Q2P" });
  });

  it("expired -> regenerate via REQUEST then ISSUED", () => {
    let state = reducePairingState({ kind: "expired", code: "OLD1-CODE" }, { type: "REQUEST" });
    expect(state.kind).toBe("requesting");

    const next: PairingCodeResponse = {
      ...issued,
      code: "AAAA-BBBB",
      expires_at: "2026-11-19T12:10:00.000Z",
    };
    state = reducePairingState(state, {
      type: "ISSUED",
      response: next,
      knownDeviceIds: new Set(),
    });
    expect(state).toMatchObject({ kind: "active", code: "AAAA-BBBB" });
  });

  it("active -> paired when a new device appears", () => {
    let state = reducePairingState(initialPairingState(), {
      type: "ISSUED",
      response: issued,
      knownDeviceIds: deviceIdSet([deviceA]),
    });

    state = reducePairingState(state, {
      type: "DEVICES",
      devices: [deviceA],
    });
    expect(state.kind).toBe("active");

    state = reducePairingState(state, {
      type: "DEVICES",
      devices: [deviceA, deviceB],
    });
    expect(state).toEqual({
      kind: "paired",
      deviceId: deviceB.id,
      deviceName: "Google Pixel 8",
    });
  });

  it("FAIL yields error state", () => {
    const state = reducePairingState(initialPairingState(), {
      type: "FAIL",
      message: "MFA required",
      code: "mfa_required",
    });
    expect(state).toEqual({
      kind: "error",
      message: "MFA required",
      code: "mfa_required",
    });
  });
});

describe("secondsRemaining", () => {
  it("ceil and clamp at zero", () => {
    expect(secondsRemaining(10_000, 9_100)).toBe(1);
    expect(secondsRemaining(10_000, 10_000)).toBe(0);
    expect(secondsRemaining(10_000, 12_000)).toBe(0);
  });
});
