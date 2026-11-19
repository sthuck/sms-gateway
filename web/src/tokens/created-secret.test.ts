import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCreatedTokenSecret } from "./created-secret";

describe("useCreatedTokenSecret", () => {
  it("shows the secret once and clears on dismiss", () => {
    const { result } = renderHook(() => useCreatedTokenSecret());

    expect(result.current.secret).toBeNull();

    act(() => {
      result.current.showSecret("smsg_pat_00000000-0000-4000-8000-000000000000_abcd");
    });
    expect(result.current.secret).toBe("smsg_pat_00000000-0000-4000-8000-000000000000_abcd");

    act(() => {
      result.current.dismissSecret();
    });
    expect(result.current.secret).toBeNull();
  });
});
