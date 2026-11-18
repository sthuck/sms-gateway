/** @deprecated Import from adapters/http-fastify or adapters/device-crypto. */
export {
  devicePlugin,
  requireDeviceAuth,
  deviceAuthPreHandler,
  type DeviceRequestContext,
  type RequireDeviceAuthOptions,
} from "../adapters/http-fastify/device-plugin.js";
export { loadDeviceAuthConfig, type DeviceAuthConfig } from "../adapters/device-crypto/config.js";
export {
  buildCanonicalString,
  verifyEs256P1363,
  signEs256P1363,
  parsePublicKeySpkiB64url,
} from "../adapters/device-crypto/signing.js";
