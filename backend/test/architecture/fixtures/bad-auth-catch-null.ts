/**
 * Negative-proof fixture: .catch(() => null) swallows infra failures.
 */
export function badNullSwallow(p: Promise<unknown>): Promise<unknown> {
  return p.catch(() => null);
}
