import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client";
import type { OwnerAccessTokenCreated, OwnerAccessTokenList } from "../api/types";

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    api: {
      get: mockGet,
      post: mockPost,
      patch: vi.fn(),
      delete: mockDelete,
    } satisfies Pick<ApiClient, "get" | "post" | "patch" | "delete">,
  }),
}));

import { TokensPage } from "./TokensPage";

describe("TokensPage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
    mockGet.mockResolvedValue({ tokens: [] } satisfies OwnerAccessTokenList);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows one-time token without curl snippet when access_headers is omitted", async () => {
    const tokenSecret = "smsg_pat_11111111-1111-4111-8111-111111111111_secret123";
    mockPost.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      name: "script",
      created_at: "2026-11-19T00:00:00.000Z",
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
      token: tokenSecret,
    } satisfies OwnerAccessTokenCreated);

    const user = userEvent.setup();
    render(<TokensPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. home assistant")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("e.g. home assistant"), "script");
    await user.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() => {
      expect(screen.getByText(tokenSecret)).toBeInTheDocument();
    });

    expect(screen.queryByLabelText("Required access headers")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy curl snippet" })).not.toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("shows access_headers and copyable curl snippet, and clears all on Dismiss", async () => {
    const tokenSecret = "smsg_pat_22222222-2222-4222-8222-222222222222_secret456";
    mockPost.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      name: "agent",
      created_at: "2026-11-19T00:00:00.000Z",
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
      token: tokenSecret,
      access_headers: {
        "CF-Access-Client-Id": "agent-id.access",
        "CF-Access-Client-Secret": "agent-secret-val",
      },
    } satisfies OwnerAccessTokenCreated);

    const user = userEvent.setup();
    const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    render(<TokensPage />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("e.g. home assistant")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText("e.g. home assistant"), "agent");
    await user.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() => {
      expect(screen.getByText(tokenSecret)).toBeInTheDocument();
    });

    const headersPre = screen.getByLabelText("Required access headers");
    expect(headersPre.textContent).toContain("CF-Access-Client-Id: agent-id.access");
    expect(headersPre.textContent).toContain("CF-Access-Client-Secret: agent-secret-val");

    const curlPre = screen.getByLabelText("Example curl command");
    expect(curlPre.textContent).toContain(`Authorization: Bearer ${tokenSecret}`);
    expect(curlPre.textContent).toContain('-H "CF-Access-Client-Id: agent-id.access"');
    expect(curlPre.textContent).toContain('-H "CF-Access-Client-Secret: agent-secret-val"');

    await user.click(screen.getByRole("button", { name: "Copy curl snippet" }));
    expect(writeTextSpy).toHaveBeenCalledWith(curlPre.textContent);
    expect(screen.getByRole("button", { name: "Copied curl" })).toBeInTheDocument();

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(tokenSecret)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Required access headers")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Example curl command")).not.toBeInTheDocument();
  });
});
