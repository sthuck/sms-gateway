import { InfrastructureError } from "../../domain/errors.js";

/** Wrap a DB call so pg/network failures surface as InfrastructureError. */
export async function withDbInfra<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw InfrastructureError.wrap(err, label);
  }
}
