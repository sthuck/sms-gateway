import type { User } from "../../domain/auth/types.js";

export type CreateUserInput = {
  ownerId: string;
  email: string;
  mfaEnrolled: boolean;
  lastAuthMethod: string | null;
  displayName: string | null;
  /** When set, user + identity are inserted in one owner-scoped transaction. */
  identity?: { issuer: string; sub: string };
};

export type UpdateAuthProfileInput = {
  ownerId: string;
  email?: string;
  mfaEnrolled: boolean;
  lastAuthMethod: string | null;
  displayName: string | null;
};

export type LinkIdentityAndUpdateInput = {
  ownerId: string;
  issuer: string;
  sub: string;
  mfaEnrolled: boolean;
  lastAuthMethod: string | null;
  displayName: string | null;
};

export type UserByEmail = {
  ownerId: string;
  email: string;
  mfaEnrolled: boolean;
};

/**
 * User persistence.
 *
 * - `null` from find* = not found (domain absence).
 * - Infra failures MUST throw `InfrastructureError`.
 */
export interface UserRepository {
  findById(ownerId: string, userId: string): Promise<User | null>;
  findByEmail(email: string): Promise<UserByEmail | null>;
  create(input: CreateUserInput): Promise<void>;
  updateAuthProfile(input: UpdateAuthProfileInput): Promise<void>;
  /** Link a new (issuer, sub) and update profile in one owner-scoped transaction. */
  linkIdentityAndUpdate(input: LinkIdentityAndUpdateInput): Promise<void>;
  /**
   * Delete the user row (CASCADE removes owned data including user_keys).
   * Returns false when the row was already absent under RLS.
   */
  deleteById(ownerId: string): Promise<boolean>;
}
