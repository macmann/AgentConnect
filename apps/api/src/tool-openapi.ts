import { parseDocument } from "yaml";
import { ToolError } from "./tool-errors.js";
import { apiOperationConfig } from "@agentconnect/schemas/tools";
import type { z } from "zod";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dynamic OpenAPI input is normalized and schema-validated before registration.
type Obj = Record<string, any>; // OpenAPI is untrusted; every emitted field is checked below.
export type ImportedOperation = {
  id: string;
  name: string;
  description: string;
  config: z.infer<typeof apiOperationConfig>;
};
function object(v: unknown): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Expected an object");
  return v as Obj;
}
/** Local references only. No network fetches, executable YAML tags or recursive schemas. */
export function importOpenApi(source: string, serverOverride?: string) {
  if (Buffer.byteLength(source) > 300000)
    throw new ToolError("OPENAPI_SPEC_TOO_LARGE");
  let doc: Obj;
  try {
    const parsed = parseDocument(source, { uniqueKeys: true, customTags: [] });
    if (parsed.errors.length || parsed.warnings.length) throw new Error();
    doc = object(parsed.toJS({ maxAliasCount: 0 }));
    if (!/^3\.[01]\./.test(doc.openapi)) throw new Error();
  } catch {
    throw new ToolError("OPENAPI_INVALID_USE_VERSION_3_JSON_OR_YAML");
  }
  function resolve(value: unknown, chain: string[] = []): Obj {
    const v = object(value);
    if (!v.$ref) return v;
    const ref = String(v.$ref);
    if (!ref.startsWith("#/") || chain.includes(ref) || chain.length > 10)
      throw new Error("Only non-recursive local references are supported");
    const target = ref
      .slice(2)
      .split("/")
      .reduce(
        (o: unknown, key: string) =>
          object(o)[key.replace(/~1/g, "/").replace(/~0/g, "~")],
        doc,
      );
    return resolve(target, [...chain, ref]);
  }
  let nodes = 0;
  function schema(value: unknown, depth = 0): Obj {
    if (++nodes > 500 || depth > 10) throw new Error("Schema is too complex");
    const s = resolve(value),
      result: Obj = {};
    if (
      s.$dynamicRef ||
      s.pattern ||
      s.patternProperties ||
      s.not ||
      s.if ||
      s.contains
    )
      throw new Error("Schema uses unsupported validation keywords");
    for (const key of [
      "type",
      "description",
      "title",
      "enum",
      "const",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
      "uniqueItems",
      "minProperties",
      "maxProperties",
      "required",
    ])
      if (s[key] !== undefined) result[key] = s[key];
    if (s.nullable && typeof result.type === "string")
      result.type = [result.type, "null"];
    if (s.properties)
      result.properties = Object.fromEntries(
        Object.entries(object(s.properties)).map(([k, v]) => [
          k,
          schema(v, depth + 1),
        ]),
      );
    if (s.items) result.items = schema(s.items, depth + 1);
    if (s.additionalProperties !== undefined)
      result.additionalProperties =
        typeof s.additionalProperties === "boolean"
          ? s.additionalProperties
          : schema(s.additionalProperties, depth + 1);
    for (const key of ["allOf", "anyOf", "oneOf"])
      if (s[key]) {
        if (!Array.isArray(s[key])) throw new Error("Invalid schema");
        result[key] = s[key].map((v: unknown) => schema(v, depth + 1));
      }
    // Formats are annotations; bounded runtime validation deliberately excludes format plugins.
    return result;
  }
  const operations: ImportedOperation[] = [],
    warnings: string[] = [],
    ids = new Set<string>();
  let entries: [string, unknown][];
  try {
    entries = Object.entries(object(doc.paths));
  } catch {
    throw new ToolError("OPENAPI_PATHS_REQUIRED");
  }
  if (entries.length > 100) throw new ToolError("OPENAPI_TOO_MANY_PATHS");
  for (const [path, rawPath] of entries) {
    let item: Obj;
    try {
      item = resolve(rawPath);
    } catch {
      warnings.push(`${path}: invalid or external path reference`);
      continue;
    }
    for (const method of ["get", "post", "put", "patch", "delete"] as const) {
      if (!item[method]) continue;
      try {
        nodes = 0;
        if (
          !path.startsWith("/") ||
          path.startsWith("//") ||
          /[?#\\]/.test(path) ||
          path
            .split("/")
            .some((s) => s === "." || s === ".." || /%2e|%2f|%5c/i.test(s))
        )
          throw new Error("Invalid operation path");
        const op = resolve(item[method]);
        const servers = op.servers ?? item.servers ?? doc.servers;
        let base = serverOverride || servers?.[0]?.url;
        if (typeof base !== "string")
          throw new Error("An absolute server URL is required");
        base = base.replace(/\{([^}]+)\}/g, (_: string, key: string) => {
          const v = servers?.[0]?.variables?.[key]?.default;
          if (typeof v !== "string")
            throw new Error("Server variable default missing");
          return v;
        });
        const u = new URL(base);
        if (
          u.username ||
          u.password ||
          u.search ||
          u.hash ||
          !["http:", "https:"].includes(u.protocol)
        )
          throw new Error("Invalid server URL");
        const combined = new Map<string, Obj>();
        for (const p of [
          ...(item.parameters ?? []),
          ...(op.parameters ?? []),
        ]) {
          const v = resolve(p);
          combined.set(v.in + ":" + v.name, v);
        }
        const parameters = [...combined.values()].map((p) => {
          if (
            !["query", "path"].includes(p.in) ||
            typeof p.name !== "string" ||
            !p.name ||
            p.name.length > 100 ||
            (p.in === "query" &&
              ((p.style && p.style !== "form") || p.explode === false))
          )
            throw new Error(
              "Only simple path and query parameters are supported",
            );
          const value = schema(p.schema);
          if (
            !(["string", "integer", "number", "boolean"] as unknown[]).includes(
              value.type,
            )
          )
            throw new Error("Parameters must have primitive types");
          return {
            name: p.name,
            in: p.in,
            required: p.in === "path" || p.required === true,
            schema: value,
          };
        });
        const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map(
          (m) => m[1],
        );
        if (
          placeholders.some(
            (n) => !parameters.some((p) => p.in === "path" && p.name === n),
          ) ||
          parameters.some(
            (p) => p.in === "path" && !placeholders.includes(p.name),
          )
        )
          throw new Error("Path parameters do not match placeholders");
        let bodySchema: Obj | null = null,
          bodyRequired = false;
        if (op.requestBody) {
          const body = resolve(op.requestBody);
          if (method === "get")
            throw new Error("GET request bodies are unsupported");
          if (!body.content?.["application/json"])
            throw new Error("Only JSON request bodies are supported");
          bodySchema = schema(body.content["application/json"].schema);
          bodyRequired = body.required === true;
        }
        const properties: Obj = {},
          required: string[] = [];
        for (const location of ["path", "query"]) {
          const ps = parameters.filter((p) => p.in === location);
          if (ps.length) {
            properties[location] = {
              type: "object",
              properties: Object.fromEntries(ps.map((p) => [p.name, p.schema])),
              required: ps.filter((p) => p.required).map((p) => p.name),
              additionalProperties: false,
            };
            if (ps.some((p) => p.required)) required.push(location);
          }
        }
        if (bodySchema) {
          properties.body = bodySchema;
          if (bodyRequired) required.push("body");
        }
        let auth: "none" | "bearer" | "api-key" = "none",
          headerName = "X-API-Key";
        const security = op.security ?? doc.security ?? [];
        if (security.length) {
          let found = false;
          for (const option of security) {
            const keys = Object.keys(object(option));
            if (!keys.length) {
              found = true;
              break;
            }
            if (keys.length !== 1) continue;
            const sec = resolve(doc.components?.securitySchemes?.[keys[0]!]);
            if (
              (sec.type === "http" && sec.scheme?.toLowerCase() === "bearer") ||
              sec.type === "oauth2"
            ) {
              auth = "bearer";
              found = true;
              break;
            }
            if (
              sec.type === "apiKey" &&
              sec.in === "header" &&
              typeof sec.name === "string" &&
              !/^(authorization|cookie|host|content-|proxy-|connection|transfer-)/i.test(
                sec.name,
              )
            ) {
              auth = "api-key";
              headerName = sec.name;
              found = true;
              break;
            }
          }
          if (!found)
            throw new Error(
              "Authentication must be bearer or an API key header",
            );
        }
        const id = String(
          op.operationId || method + "_" + path.replace(/[^A-Za-z0-9]+/g, "_"),
        ).slice(0, 128);
        if (ids.has(id)) throw new Error("Duplicate operationId");
        ids.add(id);
        const config = apiOperationConfig.parse({
          kind: "api",
          url: u.href.replace(/\/$/, ""),
          path,
          method: method.toUpperCase(),
          parameters,
          bodySchema,
          bodyRequired,
          auth,
          headerName,
          inputSchema: {
            type: "object",
            properties,
            required,
            additionalProperties: false,
          },
        });
        operations.push({
          id,
          name: String(op.summary || id).slice(0, 100),
          description: String(op.description || op.summary || id).slice(
            0,
            1500,
          ),
          config,
        });
      } catch (e) {
        warnings.push(
          `${method.toUpperCase()} ${path}: ${e instanceof Error ? e.message : "Unsupported operation"}`.slice(
            0,
            350,
          ),
        );
      }
    }
  }
  if (!operations.length)
    throw new ToolError("OPENAPI_NO_SUPPORTED_OPERATIONS");
  if (operations.length > 50)
    throw new ToolError("OPENAPI_TOO_MANY_OPERATIONS");
  return {
    title: String(doc.info?.title || "API tools").slice(0, 100),
    operations,
    warnings,
  };
}
