import { DeviceError } from "../../domain/device/errors.js";
import type { DeviceListItem } from "../../domain/device/types.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { DeviceAuthRepository } from "../../ports/outbound/device-auth-repository.js";

export const MAX_DEVICE_NAME_LEN = 120;

export type RenameDeviceDeps = {
  devices: DeviceAuthRepository;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RenameDevice {
  constructor(private readonly deps: RenameDeviceDeps) {}

  async execute(input: {
    ownerId: string;
    deviceId: string;
    name: string;
  }): Promise<DeviceListItem> {
    if (!UUID_RE.test(input.deviceId)) {
      throw new DeviceError("invalid_request", 400, "Invalid device id");
    }
    const name = input.name.trim();
    if (name.length < 1 || name.length > MAX_DEVICE_NAME_LEN) {
      throw new DeviceError(
        "invalid_request",
        400,
        `name must be 1..${MAX_DEVICE_NAME_LEN} characters`,
      );
    }

    try {
      const updated = await this.deps.devices.rename(input.ownerId, input.deviceId, name);
      if (!updated) {
        throw new DeviceError("not_found", 404, "Device not found");
      }
      return updated;
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (err instanceof DeviceError) throw err;
      throw InfrastructureError.wrap(err, "device rename failed");
    }
  }
}
