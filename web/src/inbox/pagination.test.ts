import { describe, expect, it } from "vitest";
import { inboxPaginationAction } from "./pagination";

describe("inboxPaginationAction", () => {
  it("returns null without next_cursor", () => {
    expect(
      inboxPaginationAction({
        nextCursor: null,
        messageCount: 0,
        limit: 50,
        searchQuery: "otp",
      }),
    ).toBeNull();
  });

  it('shows "Load more" for a full page without search', () => {
    expect(
      inboxPaginationAction({
        nextCursor: "abc",
        messageCount: 50,
        limit: 50,
        searchQuery: "",
      }),
    ).toEqual({ show: true, label: "Load more" });
  });

  it('shows "Keep searching" when q is set, next_cursor exists, and page is short', () => {
    expect(
      inboxPaginationAction({
        nextCursor: "abc",
        messageCount: 0,
        limit: 50,
        searchQuery: "bank",
      }),
    ).toEqual({ show: true, label: "Keep searching" });
  });

  it('shows "Keep searching" for a partial search page', () => {
    expect(
      inboxPaginationAction({
        nextCursor: "xyz",
        messageCount: 3,
        limit: 50,
        searchQuery: "code",
      }),
    ).toEqual({ show: true, label: "Keep searching" });
  });

  it('shows "Load more" when search filled the page', () => {
    expect(
      inboxPaginationAction({
        nextCursor: "xyz",
        messageCount: 50,
        limit: 50,
        searchQuery: "code",
      }),
    ).toEqual({ show: true, label: "Load more" });
  });
});
