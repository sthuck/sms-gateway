import type { Stream, StreamMode, StreamRule } from "../../domain/stream/types.js";

export type InsertStreamInput = {
  ownerId: string;
  name: string;
  mode: StreamMode;
  rulesJson: StreamRule[];
  aiPrompt: string | null;
};

export type UpdateStreamPatch = {
  name?: string;
  mode?: StreamMode;
  rulesJson?: StreamRule[];
  aiPrompt?: string | null;
};

/**
 * Owner-scoped stream persistence under RLS (`withOwner`).
 *
 * - `null` / `false` = domain absence only.
 * - Definition-changing updates bump `version`, reset `backfill_status` to
 *   `pending`, and publish `stream.reclassify` in the same transaction.
 * - Infra failures MUST throw `InfrastructureError`.
 */
export type StreamRepository = {
  insert(input: InsertStreamInput): Promise<Stream>;
  list(ownerId: string, limit: number): Promise<Stream[]>;
  findById(ownerId: string, streamId: string): Promise<Stream | null>;
  update(input: {
    ownerId: string;
    streamId: string;
    patch: UpdateStreamPatch;
  }): Promise<Stream | null>;
  delete(ownerId: string, streamId: string): Promise<boolean>;
};
