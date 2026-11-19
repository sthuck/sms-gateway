import { z } from "zod";
import type { FastifyReply } from "fastify";
import { buildProblem } from "./problems.js";

/**
 * Fastify turns repeated keys (`?q=a&q=b`) into arrays. Single-valued filters
 * must reject that (and any non-string) with 400 — never reach use-case code
 * that assumes a string (e.g. `.trim()`).
 */
export const singleQueryString = z.string({
  invalid_type_error: "must be a single string value",
});

/** Reject U+0000 so Postgres never sees it (avoids SQLSTATE 22021 → 5xx). */
export const noNulString = singleQueryString.refine((v) => !v.includes("\u0000"), {
  message: "must not contain NUL characters",
});

export const listMessagesQuerySchema = z
  .object({
    limit: singleQueryString.optional(),
    cursor: singleQueryString.optional(),
    device_id: singleQueryString.optional(),
    sender: noNulString.optional(),
    received_after: singleQueryString.optional(),
    received_before: singleQueryString.optional(),
    q: noNulString.optional(),
  })
  .passthrough();

export const listDevicesQuerySchema = z
  .object({
    limit: singleQueryString.optional(),
  })
  .passthrough();

export type ListMessagesQuery = z.infer<typeof listMessagesQuerySchema>;
export type ListDevicesQuery = z.infer<typeof listDevicesQuerySchema>;

export function sendInvalidQuery(
  reply: FastifyReply,
  instance: string,
  parsed: z.SafeParseError<unknown>,
): FastifyReply {
  const errors = parsed.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(query)",
    message: issue.message,
  }));
  const problem = buildProblem("invalid_request", 400, "Invalid query parameters", {
    instance,
  });
  return reply
    .status(400)
    .header("content-type", "application/problem+json; charset=utf-8")
    .send({ ...problem, errors });
}
