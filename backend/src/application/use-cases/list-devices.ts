import { DeviceError } from "../../domain/device/errors.js";
import type { DeviceListItem } from "../../domain/device/types.js";
import { InfrastructureError, isInfrastructureError } from "../../domain/errors.js";
import type { DeviceAuthRepository } from "../../ports/outbound/device-auth-repository.js";

export const DEFAULT_DEVICE_LIST_LIMIT = 100;
export const MAX_DEVICE_LIST_LIMIT = 100;

export type ListDevicesDeps = {
  devices: DeviceAuthRepository;
};

export type ListDevicesResult = {
  devices: DeviceListItem[];
  limit: number;
};

export class ListDevices {
  constructor(private readonly deps: ListDevicesDeps) {}

  async execute(input: { ownerId: string; limit?: number }): Promise<ListDevicesResult> {
    const limit = input.limit ?? DEFAULT_DEVICE_LIST_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DEVICE_LIST_LIMIT) {
      throw new DeviceError(
        "invalid_request",
        400,
        `limit must be an integer between 1 and ${MAX_DEVICE_LIST_LIMIT}`,
      );
    }

    try {
      const devices = await this.deps.devices.list(input.ownerId, limit);
      return { devices, limit };
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      if (err instanceof DeviceError) throw err;
      throw InfrastructureError.wrap(err, "device list failed");
    }
  }
}
