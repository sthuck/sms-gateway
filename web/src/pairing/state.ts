import type { OwnerDevice, PairingCodeResponse } from "../api/types";

export type PairingViewState =
  | { kind: "idle" }
  | { kind: "requesting" }
  | {
      kind: "active";
      code: string;
      qrPayload: string;
      expiresAt: number;
      knownDeviceIds: ReadonlySet<string>;
    }
  | { kind: "expired"; code: string }
  | { kind: "paired"; deviceId: string; deviceName: string }
  | { kind: "error"; message: string; code?: string };

export type PairingEvent =
  | { type: "REQUEST" }
  | { type: "ISSUED"; response: PairingCodeResponse; knownDeviceIds: ReadonlySet<string> }
  | { type: "TICK"; now: number }
  | { type: "DEVICES"; devices: OwnerDevice[] }
  | { type: "FAIL"; message: string; code?: string }
  | { type: "RESET" };

export function initialPairingState(): PairingViewState {
  return { kind: "idle" };
}

export function reducePairingState(state: PairingViewState, event: PairingEvent): PairingViewState {
  switch (event.type) {
    case "RESET":
      return { kind: "idle" };
    case "REQUEST":
      return { kind: "requesting" };
    case "ISSUED": {
      const expiresAt = Date.parse(event.response.expires_at);
      return {
        kind: "active",
        code: event.response.code,
        qrPayload: event.response.qr_payload,
        expiresAt: Number.isFinite(expiresAt)
          ? expiresAt
          : Date.now() + event.response.ttl_seconds * 1000,
        knownDeviceIds: event.knownDeviceIds,
      };
    }
    case "TICK":
      if (state.kind === "active" && event.now >= state.expiresAt) {
        return { kind: "expired", code: state.code };
      }
      return state;
    case "DEVICES":
      if (state.kind !== "active") return state;
      for (const device of event.devices) {
        if (!state.knownDeviceIds.has(device.id) && device.status === "active") {
          return {
            kind: "paired",
            deviceId: device.id,
            deviceName: device.name,
          };
        }
      }
      return state;
    case "FAIL":
      return { kind: "error", message: event.message, code: event.code };
    default:
      return state;
  }
}

export function secondsRemaining(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export function deviceIdSet(devices: OwnerDevice[]): Set<string> {
  return new Set(devices.map((d) => d.id));
}
