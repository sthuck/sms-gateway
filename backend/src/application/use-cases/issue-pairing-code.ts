import type { AccessHeadersMap } from "../../domain/access-headers.js";
import { formatPairingQrPayload } from "../../domain/device/pairing.js";
import { DeviceError } from "../../domain/device/errors.js";
import { isInfrastructureError, InfrastructureError } from "../../domain/errors.js";
import type { PairingCodeRepository } from "../../ports/outbound/pairing-code-repository.js";

export type IssuePairingCodeDeps = {
  pairingCodes: PairingCodeRepository;
  generateCode: () => string;
  normalizeCode: (raw: string) => string | null;
  hashCode: (normalized: string) => string;
  ttlSeconds: number;
  apiPublicUrl: string | null;
  deviceAccessHeaders?: AccessHeadersMap | null;
};

export type IssuePairingCodeResult = {
  code: string;
  qrPayload: string;
  hasAccessHeaders: boolean;
  expiresAt: string;
  ttlSeconds: number;
  pairingCodeId: string;
};

export class IssuePairingCode {
  constructor(private readonly deps: IssuePairingCodeDeps) {}

  async execute(input: { ownerId: string }): Promise<IssuePairingCodeResult> {
    const code = this.deps.generateCode();
    const normalized = this.deps.normalizeCode(code);
    if (!normalized) {
      throw new DeviceError("service_unavailable", 500, "Failed to generate pairing code", {
        retryable: true,
      });
    }
    const codeHash = this.deps.hashCode(normalized);
    const accessHeaders = this.deps.deviceAccessHeaders ?? null;
    const hasAccessHeaders = accessHeaders !== null && Object.keys(accessHeaders).length > 0;

    try {
      const row = await this.deps.pairingCodes.insert({
        ownerId: input.ownerId,
        codeHash,
        ttlSeconds: this.deps.ttlSeconds,
      });
      return {
        code,
        qrPayload: formatPairingQrPayload(code, this.deps.apiPublicUrl, accessHeaders),
        hasAccessHeaders,
        expiresAt: row.expiresAt.toISOString(),
        ttlSeconds: this.deps.ttlSeconds,
        pairingCodeId: row.id,
      };
    } catch (err) {
      if (isInfrastructureError(err) || err instanceof InfrastructureError) throw err;
      throw InfrastructureError.wrap(err, "pairing code issue failed");
    }
  }
}
