import { DeviceError } from "../../domain/device/errors.js";
import { isInfrastructureError, InfrastructureError } from "../../domain/errors.js";
import type { DeviceAuthRepository } from "../../ports/outbound/device-auth-repository.js";

export type RevokeDeviceDeps = {
  devices: DeviceAuthRepository;
};

export class RevokeDevice {
  constructor(private readonly deps: RevokeDeviceDeps) {}

  async execute(input: { ownerId: string; deviceId: string; clientIp: string }): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(input.deviceId)) {
      throw new DeviceError("invalid_request", 400, "Invalid device id");
    }
    try {
      const result = await this.deps.devices.revoke(input.ownerId, input.deviceId, input.clientIp);
      if (result === "missing") {
        throw new DeviceError("not_found", 404, "Device not found");
      }
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (err instanceof DeviceError) throw err;
      throw InfrastructureError.wrap(err, "device revoke failed");
    }
  }
}
