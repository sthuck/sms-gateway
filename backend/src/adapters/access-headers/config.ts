import { validateAccessHeaders, type AccessHeadersMap } from "../../domain/access-headers.js";

export const CF_ACCESS_CLIENT_ID_HEADER = "CF-Access-Client-Id";
export const CF_ACCESS_CLIENT_SECRET_HEADER = "CF-Access-Client-Secret";

export type ClientAccessConfig = {
  deviceHeaders: AccessHeadersMap | null;
  agentHeaders: AccessHeadersMap | null;
};

function parseCfAccessPair(
  env: NodeJS.ProcessEnv,
  idVar: string,
  secretVar: string,
): AccessHeadersMap | null {
  const clientId = env[idVar];
  const clientSecret = env[secretVar];
  const hasId = clientId !== undefined && clientId !== "";
  const hasSecret = clientSecret !== undefined && clientSecret !== "";

  if (!hasId && !hasSecret) {
    return null;
  }
  if (!hasId || !hasSecret) {
    throw new Error(
      `Invalid configuration: ${idVar} and ${secretVar} must both be set when configuring Cloudflare Access headers`,
    );
  }

  try {
    return validateAccessHeaders({
      [CF_ACCESS_CLIENT_ID_HEADER]: clientId,
      [CF_ACCESS_CLIENT_SECRET_HEADER]: clientSecret,
    });
  } catch (err) {
    throw new Error(
      `Invalid configuration for ${idVar}/${secretVar}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function loadClientAccessConfig(env: NodeJS.ProcessEnv = process.env): ClientAccessConfig {
  const shared = parseCfAccessPair(env, "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET");
  const deviceOverride = parseCfAccessPair(
    env,
    "DEVICE_CF_ACCESS_CLIENT_ID",
    "DEVICE_CF_ACCESS_CLIENT_SECRET",
  );
  const agentOverride = parseCfAccessPair(
    env,
    "AGENT_CF_ACCESS_CLIENT_ID",
    "AGENT_CF_ACCESS_CLIENT_SECRET",
  );

  return {
    deviceHeaders: deviceOverride ?? shared,
    agentHeaders: agentOverride ?? shared,
  };
}
