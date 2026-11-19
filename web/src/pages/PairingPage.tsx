import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { ApiError } from "../api/client";
import type { DeviceList, PairingCodeResponse } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { config } from "../config";
import {
  deviceIdSet,
  initialPairingState,
  reducePairingState,
  secondsRemaining,
  type PairingViewState,
} from "../pairing/state";

export function PairingPage() {
  const { api } = useAuth();
  const [state, setState] = useState<PairingViewState>(initialPairingState);
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const dispatch = useCallback((event: Parameters<typeof reducePairingState>[1]) => {
    setState((prev) => reducePairingState(prev, event));
  }, []);

  const startPolling = useCallback(() => {
    clearTimers();
    tickRef.current = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setState((prev) => reducePairingState(prev, { type: "TICK", now: t }));
    }, 250);

    pollRef.current = setInterval(() => {
      void (async () => {
        try {
          const list = await api.get<DeviceList>("/v1/devices");
          dispatch({ type: "DEVICES", devices: list.devices });
        } catch (err) {
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
            clearTimers();
            dispatch({
              type: "FAIL",
              message: err.message,
              code: err.code,
            });
          }
        }
      })();
    }, config.pairingPollIntervalMs);
  }, [api, clearTimers, dispatch]);

  const requestCode = useCallback(async () => {
    clearTimers();
    dispatch({ type: "REQUEST" });
    try {
      const list = await api.get<DeviceList>("/v1/devices");
      const known = deviceIdSet(list.devices);
      const issued = await api.post<PairingCodeResponse>("/v1/pairing-codes");
      dispatch({ type: "ISSUED", response: issued, knownDeviceIds: known });
      setNow(Date.now());
      startPolling();
    } catch (err) {
      clearTimers();
      if (err instanceof ApiError) {
        const mfa =
          err.code === "mfa_required"
            ? " Multi-factor authentication is required for this action."
            : "";
        dispatch({
          type: "FAIL",
          message: `${err.message}${mfa}`,
          code: err.code,
        });
        return;
      }
      dispatch({ type: "FAIL", message: "Failed to issue a pairing code." });
    }
  }, [api, clearTimers, dispatch, startPolling]);

  useEffect(() => {
    if (state.kind === "paired" || state.kind === "expired" || state.kind === "error") {
      clearTimers();
    }
  }, [state.kind, clearTimers]);

  useEffect(() => {
    void requestCode();
    // Intentionally once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="page pairing">
      <h1>Add device</h1>
      <p className="lede">
        Scan the QR code with the SMS Gateway Android app, or enter the short code. Codes expire
        after a few minutes.
      </p>

      <ApkHint />

      {state.kind === "requesting" || state.kind === "idle" ? (
        <p>Requesting pairing code…</p>
      ) : null}

      {state.kind === "active" ? (
        <ActiveCode
          code={state.code}
          qrPayload={state.qrPayload}
          remaining={secondsRemaining(state.expiresAt, now)}
          onRegenerate={() => void requestCode()}
        />
      ) : null}

      {state.kind === "expired" ? (
        <div className="banner banner-warn" role="status">
          <p>
            Code <strong>{state.code}</strong> expired.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => void requestCode()}>
            Generate new code
          </button>
        </div>
      ) : null}

      {state.kind === "paired" ? (
        <div className="banner banner-ok" role="status">
          <p>
            Paired <strong>{state.deviceName}</strong>.
          </p>
          <button type="button" className="btn" onClick={() => void requestCode()}>
            Pair another device
          </button>
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="banner banner-error" role="alert">
          <p>{state.message}</p>
          {state.code === "mfa_required" ? (
            <p className="hint">Sign out and sign in again with MFA completed.</p>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={() => void requestCode()}>
            Try again
          </button>
        </div>
      ) : null}
    </main>
  );
}

function ActiveCode({
  code,
  qrPayload,
  remaining,
  onRegenerate,
}: {
  code: string;
  qrPayload: string;
  remaining: number;
  onRegenerate: () => void;
}) {
  const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
  const ss = String(remaining % 60).padStart(2, "0");

  return (
    <div className="pairing-active">
      <div className="qr-wrap" aria-hidden={false}>
        <QRCodeSVG value={qrPayload} size={220} level="M" includeMargin />
      </div>
      <p className="short-code" aria-label="Pairing code">
        {code}
      </p>
      <p className="countdown" aria-live="polite">
        Expires in {mm}:{ss}
      </p>
      <p className="hint">Waiting for the device to complete pairing…</p>
      <button type="button" className="btn" onClick={onRegenerate}>
        Regenerate code
      </button>
    </div>
  );
}

function ApkHint() {
  const url = config.apkDownloadUrl;
  if (url) {
    return (
      <p className="apk-link">
        <a href={url} rel="noreferrer">
          Download Android APK / install instructions
        </a>
      </p>
    );
  }
  return (
    <p className="apk-link hint">
      APK download URL not configured yet (set <code>VITE_APK_DOWNLOAD_URL</code>). See{" "}
      <code>web/README.md</code>.
    </p>
  );
}
