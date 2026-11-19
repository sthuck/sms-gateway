import { describe, expect, it } from "vitest";
import { inboxPaginationAction } from "./pagination";

describe("inboxPaginationAction", () => {
  it("returns null without next_cursor", () => {
    expect(
      inboxPaginationAction({
        nextCursor: null,
        lastPageCount: 0,
        limit: 50,
        searchQuery: "otp",
      }),
    ).toBeNull();
  });

  it('shows "Load more" for a full page without search', () => {
    expect(
      inboxPaginationAction({
        nextCursor: "abc",
        lastPageCount: 50,
        limit: 50,
        searchQuery: "",
      }),
    ).toEqual({ show: true, label: "Load more" });
  });

  it('shows "Keep searching" when q is set, next_cursor exists, and page is short', () => {
    expect(
      inboxPaginationAction({
        nextCursor: "abc",
        lastPageCount: 0,
        limit: 50,
        searchQuery: "bank",
      }),
    ).toEqual({ show: true, label: "Keep searching" });
  });

  it('shows "Keep searching" for a partial search page', () => {
    expect(
      inboxPaginationAction({
        nextCursor: "xyz",
        lastPageCount: 3,
        limit: 50,
        searchQuery: "code",
      }),
    ).toEqual({ show: true, label: "Keep searching" });
  });

  it('shows "Load more" when search filled the page', () => {
    expect(
      inboxPaginationAction({
        nextCursor: "xyz",
        lastPageCount: 50,
        limit: 50,
        searchQuery: "code",
      }),
    ).toEqual({ show: true, label: "Load more" });
  });

  it('keeps "Keep searching" based on last page, not cumulative list size', () => {
    expect(
      inboxPaginationAction({
        nextCursor: "more",
        lastPageCount: 2,
        limit: 50,
        searchQuery: "otp",
      }),
    ).toEqual({ show: true, label: "Keep searching" });
  });
});
