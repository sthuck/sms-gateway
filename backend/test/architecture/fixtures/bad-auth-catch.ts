/**
 * Negative-proof fixture for scripts/check-auth-error-classification.mjs.
 * Intentionally collapses every failure into AuthError unauthorized (STH-46 anti-pattern).
 * Not imported by production code.
 */
import { AuthError } from "../../../src/domain/auth/errors.js";

export async function badResolve(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch {
    throw new AuthError("unauthorized", "collapsed");
  }
}
