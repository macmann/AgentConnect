"use client";
import type { WorkflowDefinitionV2 } from "@agentconnect/schemas/workflow-v2";
import type { WorkflowExpression } from "@agentconnect/schemas/workflow-values";
import { useState } from "react";
import { Button } from "./button";
export type ValueSchema = {
  type?: string;
  format?: string;
  properties?: Record<string, ValueSchema>;
  required?: string[];
  items?: ValueSchema;
  enum?: unknown[];
  additionalProperties?: boolean;
};
const safeName = (name: string) =>
  /^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(name) &&
  !["constructor", "prototype", "__proto__", "toString", "valueOf"].includes(
    name,
  );
export function schemaPaths(
  schema: ValueSchema,
  prefix = "",
  depth = 0,
): string[] {
  if (depth > 8) return [];
  return [
    prefix,
    ...Object.entries(schema.properties ?? {}).flatMap(([key, child]) =>
      /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)
        ? schemaPaths(child, prefix ? `${prefix}.${key}` : key, depth + 1)
        : [],
    ),
    ...(schema.items
      ? schemaPaths(schema.items, `${prefix}[0]`, depth + 1)
      : []),
  ];
}
export function SchemaEditor({
  value,
  onChange,
  depth = 0,
}: {
  value: ValueSchema;
  onChange: (s: ValueSchema) => void;
  depth?: number;
}) {
  const [name, setName] = useState("");
  return (
    <div className="v2-schema-editor">
      <label>
        Type
        <select
          aria-label="Schema type"
          value={value.type ?? "object"}
          onChange={(e) =>
            onChange({
              type: e.target.value,
              ...(e.target.value === "object"
                ? { properties: {}, required: [], additionalProperties: false }
                : e.target.value === "array"
                  ? { items: { type: "string" } }
                  : {}),
            })
          }
        >
          {["string", "number", "boolean", "object", "array"].map((type) => (
            <option key={type}>{type}</option>
          ))}
        </select>
      </label>
      {value.type === "string" && (
        <label>
          Text format
          <select
            value={value.format ?? ""}
            onChange={(e) =>
              onChange(
                e.target.value
                  ? { ...value, format: e.target.value }
                  : Object.fromEntries(
                      Object.entries(value).filter(([key]) => key !== "format"),
                    ),
              )
            }
          >
            <option value="">Any text</option>
            <option value="date">Date (YYYY-MM-DD)</option>
          </select>
        </label>
      )}
      {(value.type ?? "object") === "object" && (
        <>
          {Object.entries(value.properties ?? {}).map(([key, schema]) => (
            <details key={key} open>
              <summary>
                {key} · {schema.type ?? "object"}
              </summary>
              <label>
                <input
                  type="checkbox"
                  checked={value.required?.includes(key) ?? false}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      required: e.target.checked
                        ? [...(value.required ?? []), key]
                        : value.required?.filter((k) => k !== key),
                    })
                  }
                />
                Required
              </label>
              {depth < 6 && (
                <SchemaEditor
                  value={schema}
                  depth={depth + 1}
                  onChange={(s) =>
                    onChange({
                      ...value,
                      properties: { ...value.properties, [key]: s },
                    })
                  }
                />
              )}
              <Button
                onClick={() =>
                  onChange({
                    ...value,
                    properties: Object.fromEntries(
                      Object.entries(value.properties ?? {}).filter(
                        ([k]) => k !== key,
                      ),
                    ),
                    required: value.required?.filter((k) => k !== key),
                  })
                }
              >
                Remove field
              </Button>
            </details>
          ))}
          {depth < 6 && (
            <div className="v2-inline">
              <input
                aria-label="New schema field"
                placeholder="Field name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button
                disabled={
                  !safeName(name) || Object.hasOwn(value.properties ?? {}, name)
                }
                onClick={() => {
                  onChange({
                    ...value,
                    properties: {
                      ...value.properties,
                      [name]: { type: "string" },
                    },
                    required: [...(value.required ?? []), name],
                  });
                  setName("");
                }}
              >
                + Field
              </Button>
            </div>
          )}
        </>
      )}
      {value.type === "array" && depth < 6 && (
        <fieldset>
          <legend>Array items</legend>
          <SchemaEditor
            value={value.items ?? { type: "string" }}
            onChange={(s) => onChange({ ...value, items: s })}
            depth={depth + 1}
          />
        </fieldset>
      )}
    </div>
  );
}
export function StructuredFields({
  schema,
  value,
  onChange,
  label = "Value",
  depth = 0,
}: {
  schema: ValueSchema;
  value: unknown;
  onChange: (v: unknown) => void;
  label?: string;
  depth?: number;
}) {
  if (depth > 8) return <p>Value exceeds the supported form depth.</p>;
  if (!schema.type && !schema.properties)
    return (
      <fieldset>
        <legend>{label}</legend>
        <LiteralEditor
          value={value ?? ""}
          onChange={onChange}
          depth={depth + 1}
        />
      </fieldset>
    );
  if (schema.type === "object" || schema.properties) {
    const obj =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    return (
      <fieldset>
        <legend>{label}</legend>
        {Object.entries(schema.properties ?? {}).map(([key, child]) => (
          <StructuredFields
            key={key}
            schema={child}
            value={obj[key]}
            label={key + (schema.required?.includes(key) ? " *" : "")}
            onChange={(v) => onChange({ ...obj, [key]: v })}
            depth={depth + 1}
          />
        ))}
      </fieldset>
    );
  }
  if (schema.type === "array") {
    const items = Array.isArray(value) ? value : [];
    return (
      <fieldset>
        <legend>{label}</legend>
        {items.map((v, i) => (
          <div key={i}>
            <StructuredFields
              schema={schema.items ?? { type: "string" }}
              value={v}
              label={`Item ${i + 1}`}
              onChange={(next) =>
                onChange(items.map((old, j) => (i === j ? next : old)))
              }
              depth={depth + 1}
            />
            <Button onClick={() => onChange(items.filter((_, j) => i !== j))}>
              Remove item
            </Button>
          </div>
        ))}
        <Button
          onClick={() =>
            onChange([
              ...items,
              defaultValue(schema.items ?? { type: "string" }),
            ])
          }
        >
          + Item
        </Button>
      </fieldset>
    );
  }
  return (
    <label>
      {label}
      {schema.type === "boolean" ? (
        <select
          value={value === undefined ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "true")}
        >
          <option value="" disabled>
            Select
          </option>
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      ) : (
        <input
          type={
            schema.type === "number"
              ? "number"
              : schema.format === "date"
                ? "date"
                : "text"
          }
          value={
            typeof value === "string" || typeof value === "number" ? value : ""
          }
          onChange={(e) =>
            onChange(
              schema.type === "number"
                ? Number(e.target.value)
                : e.target.value,
            )
          }
        />
      )}
    </label>
  );
}
export function defaultValue(s: ValueSchema): unknown {
  return s.type === "object"
    ? Object.fromEntries(
        Object.entries(s.properties ?? {}).map(([key, child]) => [
          key,
          defaultValue(child),
        ]),
      )
    : s.type === "array"
      ? []
      : s.type === "number"
        ? 0
        : s.type === "boolean"
          ? false
          : "";
}
export function FieldPicker({
  definition,
  nodeId,
  value,
  onChange,
  referenceOnly = false,
  allowArguments = false,
}: {
  referenceOnly?: boolean;
  allowArguments?: boolean;
  definition: WorkflowDefinitionV2;
  nodeId: string;
  value: WorkflowExpression;
  onChange: (v: WorkflowExpression) => void;
}) {
  const e = definition.execution;
  const ancestors = new Set<string>();
  const controlEdges = [
    ...e.edges,
    ...e.nodes
      .filter((n) => n.onError)
      .map((n) => ({ source: n.id, target: n.onError! })),
  ];
  const pending = controlEdges
    .filter((edge) => edge.target === nodeId)
    .map((edge) => edge.source);
  while (pending.length) {
    const id = pending.pop()!;
    if (ancestors.has(id)) continue;
    ancestors.add(id);
    pending.push(
      ...controlEdges
        .filter((edge) => edge.target === id)
        .map((edge) => edge.source),
    );
  }
  const inputSchema: ValueSchema = {
    type: "object",
    properties: Object.fromEntries(
      e.inputFields.map((f) => [
        f.name,
        {
          type:
            f.type === "text"
              ? "string"
              : f.type === "json"
                ? undefined
                : f.type,
        },
      ]),
    ),
  };
  const sources: { id: string; label: string; schema: ValueSchema }[] = [
    ...(allowArguments
      ? [
          {
            id: "arguments",
            label: "Action inputs",
            schema: (e.nodes.find((n) => n.id === nodeId)?.kind === "action"
              ? e.actions.find(
                  (a) =>
                    a.id ===
                    (
                      e.nodes.find((n) => n.id === nodeId) as {
                        config: { actionId: string };
                      }
                    ).config.actionId,
                )?.inputSchema
              : {}) as ValueSchema,
          },
        ]
      : []),
    { id: "input", label: "Workflow input", schema: inputSchema },
    { id: "item", label: "Current item (iteration body)", schema: {} },
    {
      id: "iteration",
      label: "Iteration",
      schema: { type: "object", properties: { index: { type: "number" } } },
    },
    {
      id: "error",
      label: "Error",
      schema: {
        type: "object",
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          nodeId: { type: "string" },
          attempt: { type: "number" },
        },
      },
    },
    ...e.nodes
      .filter((n) => ancestors.has(n.id) && n.kind === "for-each")
      .map((n) => ({
        id: `steps.${n.id}.summary`,
        label: `${n.label} summary`,
        schema: {
          type: "object",
          properties: {
            total: { type: "number" },
            failed: { type: "number" },
            completed: { type: "number" },
          },
        },
      })),
    {
      id: "trigger",
      label: "Trigger",
      schema: {
        type: "object",
        properties: { type: { type: "string" }, body: inputSchema },
      },
    },
    {
      id: "variables",
      label: "Variables",
      schema: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(e.variables).map(([key, v]) => [
            key,
            { type: typeof v },
          ]),
        ),
      },
    },
    {
      id: "workflow",
      label: "Workflow details",
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          versionId: { type: "string" },
          runId: { type: "string" },
          schemaVersion: { type: "number" },
        },
      },
    },
    ...e.nodes
      .filter((n) => ancestors.has(n.id))
      .map((n) => ({
        id: `steps.${n.id}.output`,
        label: n.label,
        schema: (n.kind === "structured-ai" || n.kind === "human-task"
          ? n.config.outputSchema
          : n.kind === "action"
            ? e.actions.find((a) => a.id === n.config.actionId)?.outputSchema
            : n.kind === "transform"
              ? {
                  type: "object",
                  properties: Object.fromEntries(
                    Object.keys(n.config.fields).map((key) => [key, {}]),
                  ),
                }
              : {}) as ValueSchema,
      })),
  ];
  const source =
    value.type === "reference"
      ? sources.find(
          (s) =>
            value.path === s.id ||
            value.path.startsWith(s.id + ".") ||
            value.path.startsWith(s.id + "["),
        )
      : undefined;
  const field =
    value.type === "reference" && source
      ? value.path.slice(source.id.length).replace(/^\./, "")
      : "";
  return (
    <fieldset className="v2-field-picker">
      <legend>Value source</legend>
      <select
        aria-label="Value source"
        value={value.type === "literal" ? "literal" : (source?.id ?? "input")}
        onChange={(event) =>
          onChange(
            event.target.value === "literal"
              ? { type: "literal", value: "" }
              : { type: "reference", path: event.target.value },
          )
        }
      >
        {!referenceOnly && <option value="literal">Literal value</option>}
        {sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      {value.type === "reference" && (
        <>
          <label>
            Field
            <select
              aria-label="Known field"
              value={
                schemaPaths(source?.schema ?? {}).includes(field)
                  ? field
                  : "custom"
              }
              onChange={(event) => {
                if (event.target.value !== "custom")
                  onChange({
                    type: "reference",
                    path:
                      source!.id +
                      (event.target.value.startsWith("[")
                        ? ""
                        : event.target.value
                          ? "."
                          : "") +
                      event.target.value,
                  });
              }}
            >
              <option value="">Whole value</option>
              {schemaPaths(source?.schema ?? {})
                .filter(Boolean)
                .map((path) => (
                  <option key={path} value={path}>
                    {path.replaceAll(".", " → ")}
                  </option>
                ))}
              <option value="custom">Other nested field</option>
            </select>
          </label>
          <label>
            Nested field / array index
            <input
              aria-label="Nested field"
              placeholder="customer.email or items[0].total"
              value={field}
              onChange={(event) =>
                onChange({
                  type: "reference",
                  path:
                    (source?.id ?? "input") +
                    (event.target.value.startsWith("[")
                      ? ""
                      : event.target.value
                        ? "."
                        : "") +
                    event.target.value,
                })
              }
            />
          </label>
        </>
      )}
      {value.type === "literal" && (
        <LiteralEditor
          value={value.value}
          onChange={(v) => onChange({ type: "literal", value: v as never })}
        />
      )}
    </fieldset>
  );
}

function LiteralEditor({
  value,
  onChange,
  depth = 0,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  depth?: number;
}) {
  const [name, setName] = useState("");
  const type =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const entries =
    type === "object" ? Object.entries(value as Record<string, unknown>) : [];
  if (depth > 8) return <p>Maximum nesting reached.</p>;
  return (
    <div>
      <label>
        Literal type
        <select
          value={type}
          onChange={(e) =>
            onChange(
              e.target.value === "null"
                ? null
                : defaultValue({ type: e.target.value }),
            )
          }
        >
          {["string", "number", "boolean", "object", "array", "null"].map(
            (t) => (
              <option key={t}>{t}</option>
            ),
          )}
        </select>
      </label>
      {type === "object" ? (
        <>
          {entries.map(([key, v]) => (
            <details key={key} open>
              <summary>{key}</summary>
              <LiteralEditor
                value={v}
                depth={depth + 1}
                onChange={(next) =>
                  onChange({
                    ...(value as Record<string, unknown>),
                    [key]: next,
                  })
                }
              />
              <Button
                onClick={() =>
                  onChange(
                    Object.fromEntries(entries.filter(([k]) => k !== key)),
                  )
                }
              >
                Remove {key}
              </Button>
            </details>
          ))}
          <input
            aria-label="Literal field name"
            placeholder="Field name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            disabled={!safeName(name) || Object.hasOwn(value as object, name)}
            onClick={() => {
              onChange({ ...(value as Record<string, unknown>), [name]: "" });
              setName("");
            }}
          >
            + Literal field
          </Button>
        </>
      ) : type === "array" ? (
        <>
          {(value as unknown[]).map((v, i) => (
            <fieldset key={i}>
              <legend>Item {i + 1}</legend>
              <LiteralEditor
                value={v}
                depth={depth + 1}
                onChange={(next) =>
                  onChange(
                    (value as unknown[]).map((old, j) =>
                      i === j ? next : old,
                    ),
                  )
                }
              />
              <Button
                onClick={() =>
                  onChange((value as unknown[]).filter((_, j) => i !== j))
                }
              >
                Remove item
              </Button>
            </fieldset>
          ))}
          <Button onClick={() => onChange([...(value as unknown[]), ""])}>
            + Item
          </Button>
        </>
      ) : type !== "null" ? (
        <StructuredFields schema={{ type }} value={value} onChange={onChange} />
      ) : null}
    </div>
  );
}

export function WorkflowMappings({
  fields,
  definition,
  nodeId,
  onChange,
  known,
  allowHyphens = false,
  allowArguments = false,
}: {
  fields: Record<string, WorkflowExpression>;
  definition: WorkflowDefinitionV2;
  nodeId: string;
  onChange: (f: Record<string, WorkflowExpression>) => void;
  known?: ValueSchema;
  allowHyphens?: boolean;
  allowArguments?: boolean;
}) {
  const [name, setName] = useState("");
  return (
    <div>
      {Object.entries(fields).map(([key, value]) => (
        <details key={key} open>
          <summary>
            {key}
            {known?.properties?.[key]?.type
              ? ` · ${known.properties[key].type}`
              : ""}
          </summary>
          <FieldPicker
            allowArguments={allowArguments}
            definition={definition}
            nodeId={nodeId}
            value={value}
            onChange={(v) => onChange({ ...fields, [key]: v })}
          />
          <Button
            onClick={() =>
              onChange(
                Object.fromEntries(
                  Object.entries(fields).filter(([k]) => k !== key),
                ),
              )
            }
          >
            Remove {key}
          </Button>
        </details>
      ))}
      <div className="v2-inline">
        {known?.properties ? (
          <select
            aria-label="Input field to map"
            value={name}
            onChange={(e) => setName(e.target.value)}
          >
            <option value="">Choose input field</option>
            {Object.keys(known.properties)
              .filter((k) => !Object.hasOwn(fields, k))
              .map((k) => (
                <option key={k}>{k}</option>
              ))}
          </select>
        ) : (
          <input
            aria-label="Output field name"
            placeholder="Field name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <Button
          disabled={
            !(
              allowHyphens
                ? /^[A-Za-z][A-Za-z0-9_-]{0,47}$/
                : /^[A-Za-z][A-Za-z0-9_]{0,47}$/
            ).test(name) ||
            ["constructor", "prototype", "__proto__"].includes(name) ||
            Object.hasOwn(fields, name)
          }
          onClick={() => {
            onChange({
              ...fields,
              [name]: {
                type: "literal",
                value: defaultValue(
                  known?.properties?.[name] ?? { type: "string" },
                ) as never,
              },
            });
            setName("");
          }}
        >
          + Mapping
        </Button>
      </div>
    </div>
  );
}
