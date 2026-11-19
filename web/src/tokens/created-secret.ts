import { useCallback, useState } from "react";

/** Holds a newly created PAT secret only in React state (never storage). */
export function useCreatedTokenSecret() {
  const [secret, setSecret] = useState<string | null>(null);

  const showSecret = useCallback((token: string) => {
    setSecret(token);
  }, []);

  const dismissSecret = useCallback(() => {
    setSecret(null);
  }, []);

  return { secret, showSecret, dismissSecret };
}
