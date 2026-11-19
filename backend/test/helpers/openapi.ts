import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import SwaggerParser from "@apidevtools/swagger-parser";
import { expect } from "vitest";

const require = createRequire(import.meta.url);
const Ajv = require("ajv") as new (opts?: object) => {
  compile: (schema: object) => ((data: unknown) => boolean) & { errors?: unknown };
};
const addFormats = require("ajv-formats") as (ajv: InstanceType<typeof Ajv>) => void;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export type JsonSchema = Record<string, unknown>;

export type OpenApiDoc = {
  paths: Record<
    string,
    Record<
      string,
      {
        security?: Array<Record<string, string[]>>;
        responses: Record<
          string,
          {
            content?: Record<string, { schema?: JsonSchema }>;
          }
        >;
      }
    >
  >;
  components?: {
    schemas?: Record<string, JsonSchema>;
    responses?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
};

let userApiCache: OpenApiDoc | undefined;

export async function loadUserApi(): Promise<OpenApiDoc> {
  if (!userApiCache) {
    userApiCache = (await SwaggerParser.dereference(
      path.join(repoRoot, "docs/contracts/user-api.yaml"),
    )) as unknown as OpenApiDoc;
  }
  return userApiCache;
}

export function responseSchema(
  doc: OpenApiDoc,
  pathKey: string,
  method: string,
  status: string,
  contentType: string,
): JsonSchema {
  const schema = doc.paths[pathKey]?.[method]?.responses?.[status]?.content?.[contentType]?.schema;
  if (!schema) {
    throw new Error(
      `No schema for ${method.toUpperCase()} ${pathKey} → ${status} (${contentType})`,
    );
  }
  return schema;
}

export function compileValidator(schema: JsonSchema) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: true,
  });
  addFormats(ajv);
  return ajv.compile(schema);
}

type InjectResponse = {
  statusCode: number;
  headers: Record<string, unknown>;
  json: () => unknown;
  body: string;
};

/**
 * Assert status + JSON body against an OpenAPI response content schema.
 */
export function expectOpenApiResponse(
  doc: OpenApiDoc,
  pathKey: string,
  method: string,
  res: InjectResponse,
  opts: { status: number; contentType: string },
): unknown {
  expect(res.statusCode).toBe(opts.status);
  const ct = String(res.headers["content-type"] ?? "");
  expect(ct).toMatch(new RegExp(opts.contentType.replace("+", "\\+")));
  const schema = responseSchema(doc, pathKey, method, String(opts.status), opts.contentType);
  const validate = compileValidator(schema);
  const body = res.json();
  const ok = validate(body);
  if (!ok) {
    expect.fail(
      `OpenAPI validation failed for ${method.toUpperCase()} ${pathKey} → ${opts.status}: ${JSON.stringify(validate.errors)}`,
    );
  }
  return body;
}

/** Validate Me (200) from GET /v1/auth/me. */
export function expectMe(doc: OpenApiDoc, res: InjectResponse): unknown {
  return expectOpenApiResponse(doc, "/v1/auth/me", "get", res, {
    status: 200,
    contentType: "application/json",
  });
}

/** Validate RFC 9457 problem+json error body for an auth path. */
export function expectAuthProblem(
  doc: OpenApiDoc,
  pathKey: string,
  method: string,
  res: InjectResponse,
  status: number,
): unknown {
  return expectOpenApiResponse(doc, pathKey, method, res, {
    status,
    contentType: "application/problem+json",
  });
}

/** Lightweight health shape (not in user-api.yaml). */
export function expectHealthBody(res: InjectResponse, status: "ok" | "ready"): void {
  expect(res.statusCode).toBe(200);
  const schema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["status"],
    properties: { status: { type: "string", const: status } },
  };
  const validate = compileValidator(schema);
  const body = res.json();
  expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
}
