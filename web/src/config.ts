/**
 * Runtime config (build-time Vite env only — no secrets).
 *
 * VITE_API_BASE_URL: empty = same origin (prod + Vite proxy). Set only if the
 * API is on a different origin and CORS + cookie domain are configured.
 *
 * VITE_APK_DOWNLOAD_URL: placeholder until the Android release ticket publishes
 * a real download URL. Leave unset to show install-instructions placeholder.
 */
export const config = {
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, ""),
  apkDownloadUrl: import.meta.env.VITE_APK_DOWNLOAD_URL?.trim() || null,
  pairingPollIntervalMs: 2500,
  csrfCookieName: "sms_csrf",
} as const;

export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${config.apiBaseUrl}${p}`;
}
