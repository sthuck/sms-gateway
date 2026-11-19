import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import type { DeviceList, PairingCodeResponse } from "../api/types";

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    api: {
      get: mockGet,
      post: mockPost,
      patch: vi.fn(),
      delete: vi.fn(),
    } satisfies Pick<ApiClient, "get" | "post" | "patch" | "delete">,
  }),
}));

import { PairingPage } from "./PairingPage";

describe("PairingPage", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
    mockGet.mockResolvedValue({ devices: [], limit: 100 } satisfies DeviceList);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders size 220 QR without tunnel notice when has_access_headers is false", async () => {
    mockPost.mockResolvedValue({
      code: "7K3M-9Q2P",
      qr_payload: "smsgw://pair?code=7K3M-9Q2P",
      has_access_headers: false,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      ttl_seconds: 300,
    } satisfies PairingCodeResponse);

    const { container } = render(<PairingPage />);

    await waitFor(() => {
      expect(screen.getByText("7K3M-9Q2P")).toBeInTheDocument();
    });

    const svg = container.querySelector(".qr-wrap svg");
    expect(svg).toHaveAttribute("width", "220");
    expect(screen.queryByText(/Tunnel access headers are embedded/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy pairing URI" })).toBeInTheDocument();
  });

  it("renders size 260 QR, tunnel notice, copies URI, and resets copied state on regenerate", async () => {
    const uri1 = "smsgw://pair?code=7K3M-9Q2P&headers=eyJDRi1BY2Nlc3MtQ2xpZW50LUlkIjoiMSJ9";
    const uri2 = "smsgw://pair?code=AAAA-BBBB&headers=eyJDRi1BY2Nlc3MtQ2xpZW50LUlkIjoiMSJ9";

    mockPost
      .mockResolvedValueOnce({
        code: "7K3M-9Q2P",
        qr_payload: uri1,
        has_access_headers: true,
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        ttl_seconds: 300,
      } satisfies PairingCodeResponse)
      .mockResolvedValueOnce({
        code: "AAAA-BBBB",
        qr_payload: uri2,
        has_access_headers: true,
        expires_at: new Date(Date.now() + 300_000).toISOString(),
        ttl_seconds: 300,
      } satisfies PairingCodeResponse);

    const user = userEvent.setup();
    const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const { container } = render(<PairingPage />);

    await waitFor(() => {
      expect(screen.getByText("7K3M-9Q2P")).toBeInTheDocument();
    });

    const svg = container.querySelector(".qr-wrap svg");
    expect(svg).toHaveAttribute("width", "260");
    expect(screen.getByText(/Tunnel access headers are embedded/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy pairing URI" }));
    expect(writeTextSpy).toHaveBeenCalledWith(uri1);
    expect(screen.getByRole("button", { name: "Copied pairing URI" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Regenerate code" }));

    await waitFor(() => {
      expect(screen.getByText("AAAA-BBBB")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Copy pairing URI" })).toBeInTheDocument();
  });
});
