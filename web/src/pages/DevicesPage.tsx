import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";
import type { DeviceList, OwnerDevice } from "../api/types";
import { useAuth } from "../auth/AuthContext";

export function DevicesPage() {
  const { api } = useAuth();
  const [devices, setDevices] = useState<OwnerDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await api.get<DeviceList>("/v1/devices?limit=100");
      setDevices(list.devices);
    } catch (err) {
      setDevices([]);
      setError(err instanceof ApiError ? err.message : "Failed to load devices.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRename = async (device: OwnerDevice, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const input = form.elements.namedItem("name") as HTMLInputElement;
    const name = input.value.trim();
    if (!name || name === device.name) {
      return;
    }
    setRenamingId(device.id);
    setError(null);
    try {
      const updated = await api.patch<OwnerDevice>(`/v1/devices/${device.id}`, { name });
      setDevices((prev) => prev.map((d) => (d.id === device.id ? updated : d)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to rename device.");
    } finally {
      setRenamingId(null);
    }
  };

  const onRevoke = async (device: OwnerDevice) => {
    if (device.status === "revoked") {
      return;
    }
    if (
      !window.confirm(`Revoke "${device.name}"? The phone will stop forwarding until paired again.`)
    ) {
      return;
    }
    setRevokingId(device.id);
    setError(null);
    try {
      await api.post<void>(`/v1/devices/${device.id}/revoke`);
      setDevices((prev) =>
        prev.map((d) =>
          d.id === device.id
            ? { ...d, status: "revoked" as const, revoked_at: new Date().toISOString() }
            : d,
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to revoke device.");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <main className="page">
      <h1>Devices</h1>
      <p className="lede">
        Phones paired to your account. <Link to="/devices/pair">Add device</Link>
      </p>

      {error ? (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? <p>Loading devices…</p> : null}

      {!loading && devices.length === 0 ? <p className="hint">No devices paired yet.</p> : null}

      {!loading && devices.length > 0 ? (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Status</th>
              <th scope="col">Last seen</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr key={device.id}>
                <td>
                  <form className="inline-form" onSubmit={(e) => void onRename(device, e)}>
                    <input
                      name="name"
                      type="text"
                      defaultValue={device.name}
                      maxLength={120}
                      aria-label={`Name for ${device.name}`}
                    />
                    <button type="submit" className="btn" disabled={renamingId === device.id}>
                      {renamingId === device.id ? "Saving…" : "Rename"}
                    </button>
                  </form>
                </td>
                <td>{device.status}</td>
                <td>
                  {device.last_seen_at ? new Date(device.last_seen_at).toLocaleString() : "—"}
                </td>
                <td>
                  {device.status === "active" ? (
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={revokingId === device.id}
                      onClick={() => void onRevoke(device)}
                    >
                      {revokingId === device.id ? "Revoking…" : "Revoke"}
                    </button>
                  ) : (
                    <span className="hint">Revoked</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </main>
  );
}
