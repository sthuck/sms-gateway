import { describe, expect, it } from "vitest";
import {
  CreateStream,
  DeleteStream,
  GetStream,
  ListStreams,
  UpdateStream,
} from "../../src/application/use-cases/index.js";
import { StreamError } from "../../src/domain/stream/errors.js";
import { InfrastructureError } from "../../src/domain/errors.js";
import { MemoryStreamRepository } from "./fakes/memory-ports.js";

const OWNER = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";

function stack(streams = new MemoryStreamRepository()) {
  return {
    streams,
    create: new CreateStream({ streams }),
    list: new ListStreams({ streams }),
    get: new GetStream({ streams }),
    update: new UpdateStream({ streams }),
    delete: new DeleteStream({ streams }),
  };
}

describe("stream use cases", () => {
  it("creates, lists, gets, and deletes a stream", async () => {
    const s = stack();
    const created = await s.create.execute({
      ownerId: OWNER,
      name: "Banks",
      mode: "rules",
      rulesJson: [{ type: "sender_prefix", value: "+1" }],
    });
    expect(created.version).toBe(1);
    expect(created.rulesJson).toEqual([{ type: "sender_prefix", value: "+1" }]);

    const listed = await s.list.execute({ ownerId: OWNER });
    expect(listed).toHaveLength(1);

    const got = await s.get.execute({ ownerId: OWNER, streamId: created.id });
    expect(got.id).toBe(created.id);

    await s.delete.execute({ ownerId: OWNER, streamId: created.id });
    await expect(s.get.execute({ ownerId: OWNER, streamId: created.id })).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("rejects invalid rules with field-pathed StreamError", async () => {
    const s = stack();
    await expect(
      s.create.execute({
        ownerId: OWNER,
        name: "Bad",
        mode: "rules",
        rulesJson: [{ type: "body_regex", pattern: "(a+)+$" }],
      }),
    ).rejects.toBeInstanceOf(StreamError);
  });

  it("bumps version and publishes reclassify once on definition change", async () => {
    const s = stack();
    const created = await s.create.execute({
      ownerId: OWNER,
      name: "A",
      mode: "rules",
      rulesJson: [],
    });
    expect(s.streams.published).toHaveLength(0);

    const updated = await s.update.execute({
      ownerId: OWNER,
      streamId: created.id,
      rulesJson: [{ type: "sender_equals", value: "Bank" }],
    });
    expect(updated.version).toBe(2);
    expect(s.streams.published).toEqual([
      {
        type: "stream.reclassify",
        owner_id: OWNER,
        stream_id: created.id,
        version: 2,
      },
    ]);

    await s.update.execute({
      ownerId: OWNER,
      streamId: created.id,
      mode: "hybrid",
      aiPrompt: "bank OTPs",
    });
    expect(s.streams.published).toHaveLength(2);
    expect(s.streams.published[1]?.version).toBe(3);
  });

  it("does not bump version or enqueue on name-only PATCH", async () => {
    const s = stack();
    const created = await s.create.execute({
      ownerId: OWNER,
      name: "A",
      mode: "rules",
      rulesJson: [{ type: "sim_slot", slot: 1 }],
    });
    const updated = await s.update.execute({
      ownerId: OWNER,
      streamId: created.id,
      name: "Renamed",
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.version).toBe(1);
    expect(s.streams.published).toHaveLength(0);
  });

  it("returns not_found for other owner's stream (memory isolation)", async () => {
    const s = stack();
    const created = await s.create.execute({
      ownerId: OWNER,
      name: "A",
      mode: "ai",
      aiPrompt: "x",
    });
    await expect(s.get.execute({ ownerId: OTHER, streamId: created.id })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      s.update.execute({ ownerId: OTHER, streamId: created.id, name: "Hack" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(s.delete.execute({ ownerId: OTHER, streamId: created.id })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("propagates InfrastructureError from the port", async () => {
    const streams = new MemoryStreamRepository();
    streams.fault.throwInfra = true;
    const create = new CreateStream({ streams });
    await expect(
      create.execute({ ownerId: OWNER, name: "A", mode: "rules" }),
    ).rejects.toBeInstanceOf(InfrastructureError);
  });
});
