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

export interface UserRepository {
  findById(ownerId: string, userId: string): Promise<User | null>;
  findByEmail(email: string): Promise<UserByEmail | null>;
  create(input: CreateUserInput): Promise<void>;
  updateAuthProfile(input: UpdateAuthProfileInput): Promise<void>;
  /** Link a new (issuer, sub) and update profile in one owner-scoped transaction. */
  linkIdentityAndUpdate(input: LinkIdentityAndUpdateInput): Promise<void>;
}
