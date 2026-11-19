/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  /** Placeholder until Android release publishes a real APK URL (STH Android release). */
  readonly VITE_APK_DOWNLOAD_URL?: string;
  /** CSRF double-submit cookie name (default `sms_csrf`). */
  readonly VITE_CSRF_COOKIE_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
