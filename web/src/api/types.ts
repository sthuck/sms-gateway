export type ProblemCode =
  | "unauthorized"
  | "mfa_required"
  | "csrf_rejected"
  | "auth_misconfigured"
  | "invalid_request"
  | "not_found"
  | "service_unavailable"
  | "internal_error"
  | string;

export type ProblemBody = {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  code?: ProblemCode;
  retryable?: boolean;
};

export type Me = {
  id: string;
  email: string;
  mfa_enrolled: boolean;
  display_name: string | null;
  last_auth_method: string | null;
  auth_method: "session" | "bearer" | null;
};

export type PairingCodeResponse = {
  code: string;
  qr_payload: string;
  expires_at: string;
  ttl_seconds: number;
};

export type OwnerDevice = {
  id: string;
  name: string;
  status: "active" | "revoked";
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
};

export type DeviceList = {
  devices: OwnerDevice[];
  limit: number;
};

export type OwnerMessage = {
  id: string;
  sender: string;
  body: string;
  received_at: string;
  device_id: string;
  sim_slot: number | null;
  direction: "inbound" | "outbound";
};

export type OwnerMessageList = {
  messages: OwnerMessage[];
  next_cursor: string | null;
  limit: number;
};

export type OwnerAccessToken = {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

export type OwnerAccessTokenCreated = OwnerAccessToken & {
  token: string;
};

export type OwnerAccessTokenList = {
  tokens: OwnerAccessToken[];
};
