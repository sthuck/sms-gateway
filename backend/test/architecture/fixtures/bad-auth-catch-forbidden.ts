/**
 * Negative-proof fixture: catch → AuthError("forbidden") without infra rethrow.
 */
import { AuthError } from "../../../src/domain/auth/errors.js";

export async function badForbidden(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch {
    throw new AuthError("unauthorized", "forbidden-collapse");
  }
}
