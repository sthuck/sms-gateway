import { DeviceError } from "../../domain/device/errors.js";
import type { DeviceMe } from "../../domain/device/types.js";
import { isInfrastructureError, InfrastructureError } from "../../domain/errors.js";
import type { DeviceAuthRepository } from "../../ports/outbound/device-auth-repository.js";

export type GetDeviceMeDeps = {
  devices: DeviceAuthRepository;
};

export class GetDeviceMe {
  constructor(private readonly deps: GetDeviceMeDeps) {}

  async execute(input: { ownerId: string; deviceId: string }): Promise<DeviceMe> {
    try {
      const row = await this.deps.devices.findMe(input.ownerId, input.deviceId);
      if (!row) {
        throw new DeviceError("device_unknown", 401, "Unknown or deleted device");
      }
      return row;
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (err instanceof DeviceError) throw err;
      throw InfrastructureError.wrap(err, "device me failed");
    }
  }
}
