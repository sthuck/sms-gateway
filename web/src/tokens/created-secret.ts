import { useCallback, useState } from "react";

export type CreatedTokenSecret = {
  token: string;
  accessHeaders: Record<string, string> | null;
};

/**
 * Holds a newly created PAT secret and optional access headers only in React
 * state (never persisted to localStorage/sessionStorage).
 */
export function useCreatedTokenSecret() {
  const [created, setCreated] = useState<CreatedTokenSecret | null>(null);

  const showSecret = useCallback((token: string, accessHeaders?: Record<string, string> | null) => {
    const normalizedHeaders =
      accessHeaders && Object.keys(accessHeaders).length > 0 ? { ...accessHeaders } : null;
    setCreated({ token, accessHeaders: normalizedHeaders });
  }, []);

  const dismissSecret = useCallback(() => {
    setCreated(null);
  }, []);

  return {
    created,
    secret: created?.token ?? null,
    accessHeaders: created?.accessHeaders ?? null,
    showSecret,
    dismissSecret,
  };
}
