import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import type { DeviceList, OwnerDevice } from "../api/types";

const mockGet = vi.fn();
const mockPatch = vi.fn();
const mockPost = vi.fn();

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    api: {
      get: mockGet,
      patch: mockPatch,
      post: mockPost,
      delete: vi.fn(),
    } satisfies Pick<ApiClient, "get" | "patch" | "post" | "delete">,
  }),
}));

import { DevicesPage } from "./DevicesPage";

const device: OwnerDevice = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Pixel",
  status: "active",
  created_at: "2026-01-01T00:00:00.000Z",
  last_seen_at: null,
  revoked_at: null,
};

describe("DevicesPage revoke", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockGet.mockResolvedValue({ devices: [device], limit: 100 } satisfies DeviceList);
  });

  it("calls revoke when the user confirms", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockPost.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <DevicesPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Revoke" }));

    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(mockPost).toHaveBeenCalledWith(`/v1/devices/${device.id}/revoke`);
    confirmSpy.mockRestore();
  });

  it("skips revoke when the user declines", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <DevicesPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Revoke" }));

    expect(mockPost).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
