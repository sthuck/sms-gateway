import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";

const mockGet = vi.fn();
const mockPost = vi.fn();

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createApiClient: () => ({
      get: mockGet,
      post: mockPost,
      patch: vi.fn(),
      delete: vi.fn(),
    }),
    startLoginRedirect: vi.fn(),
  };
});

import { AuthProvider, useAuth } from "./AuthContext";

function StatusProbe() {
  const { status, bootError } = useAuth();
  return (
    <div data-testid="probe">
      {status}
      {bootError ? `|${bootError}` : ""}
    </div>
  );
}

describe("AuthProvider refresh", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPost.mockReset();
  });

  it("sets anonymous on 401", async () => {
    mockGet.mockRejectedValue(
      new ApiError(401, "Unauthorized", { code: "unauthorized", status: 401, retryable: false }),
    );

    render(
      <MemoryRouter>
        <AuthProvider>
          <StatusProbe />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toBe("anonymous");
    });
  });

  it("does not clear session on 5xx boot failure", async () => {
    mockGet.mockRejectedValue(
      new ApiError(503, "Service unavailable", {
        code: "service_unavailable",
        status: 503,
        retryable: true,
      }),
    );

    render(
      <MemoryRouter>
        <AuthProvider>
          <StatusProbe />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const text = screen.getByTestId("probe").textContent ?? "";
      expect(text.startsWith("boot_error")).toBe(true);
      expect(text).not.toContain("anonymous");
    });
  });

  it("keeps authenticated when refresh fails with 5xx but user was loaded", async () => {
    mockGet
      .mockResolvedValueOnce({
        id: "u1",
        email: "a@example.com",
        mfa_enrolled: true,
        display_name: null,
        last_auth_method: null,
        auth_method: "session",
      })
      .mockRejectedValueOnce(
        new ApiError(500, "Internal error", {
          code: "internal_error",
          status: 500,
          retryable: true,
        }),
      );

    function ManualRefresh() {
      const { refresh } = useAuth();
      return (
        <div>
          <StatusProbe />
          <button type="button" onClick={() => void refresh()}>
            refresh
          </button>
        </div>
      );
    }

    render(
      <MemoryRouter>
        <AuthProvider>
          <ManualRefresh />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toBe("authenticated");
    });

    screen.getByRole("button", { name: "refresh" }).click();

    await waitFor(() => {
      expect(screen.getByTestId("probe").textContent).toBe("authenticated");
    });
  });
});
