/** Decides inbox "load more" UI when `next_cursor` is present. */
export type InboxPaginationInput = {
  nextCursor: string | null;
  /** Messages returned on the latest response page (not the cumulative list). */
  lastPageCount: number;
  limit: number;
  /** Non-empty when a body search (`q`) is active. */
  searchQuery: string;
};

export type InboxPaginationAction = {
  show: true;
  label: "Load more" | "Keep searching";
};

export function inboxPaginationAction(input: InboxPaginationInput): InboxPaginationAction | null {
  const { nextCursor, lastPageCount, limit, searchQuery } = input;
  if (!nextCursor) {
    return null;
  }

  const searching = searchQuery.trim().length > 0;
  if (searching && lastPageCount < limit) {
    return { show: true, label: "Keep searching" };
  }

  return { show: true, label: "Load more" };
}
