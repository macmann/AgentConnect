"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { workflowAction } from "@agentconnect/schemas/workflow-actions";
import {
  documentDatabaseTemplate,
  type DocumentTemplateOptions,
} from "@agentconnect/schemas/workflow-document-template";
import {
  SchemaEditor,
  schemaPaths,
  type ValueSchema,
} from "./workflow-v2-fields";
import type { WorkflowCatalog } from "./workflow-v2-node-panel";
import { requestJson } from "./agent-client";
import { Button } from "./button";
export function WorkflowDocumentTemplate({
  workspaceId,
  onCreated,
  onCancel,
}: {
  workspaceId: string;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const catalog = useQuery({
    queryKey: ["workflow-catalog", workspaceId],
    queryFn: () =>
      requestJson<WorkflowCatalog>(
        `/workspaces/${workspaceId}/workflow-catalog`,
      ),
  });
  const [name, setName] = useState("Document → Structured Database"),
    [model, setModel] = useState(""),
    [agent, setAgent] = useState(""),
    [mode, setMode] = useState("structured"),
    [schema, setSchema] = useState<ValueSchema>({
      type: "object",
      properties: { recordId: { type: "string" }, text: { type: "string" } },
      required: ["recordId", "text"],
      additionalProperties: false,
    }),
    [instruction, setInstruction] = useState(
      "Extract each document into the configured fields. Preserve factual values and use the reviewed sample as formatting guidance.",
    ),
    [server, setServer] = useState(""),
    [write, setWrite] = useState(""),
    [read, setRead] = useState(""),
    [writeMap, setWriteMap] = useState<Record<string, string>>({}),
    [readMap, setReadMap] = useState<Record<string, string>>({}),
    [checks, setChecks] = useState<string[]>([]),
    [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [bodyId, setBody] = useState(""),
    [bodyVersion, setVersion] = useState(""),
    [maxItems, setMax] = useState(25);
  const [validationMap, setValidationMap] = useState<Record<string, string>>(
    {},
  );
  const connector = catalog.data?.connections?.mcp.find((c) => c.id === server),
    w = connector?.operations.find((o) => o.name === write),
    r = connector?.operations.find((o) => o.name === read),
    fields = Object.keys(schema.properties ?? {});
  const readPaths =
    r && Object.keys(r.outputSchema as object).length
      ? schemaPaths(r.outputSchema as ValueSchema).filter(Boolean)
      : fields;
  const mappings = (
    operation: typeof w,
    values: Record<string, string>,
    set: (v: Record<string, string>) => void,
  ) => (
    <div>
      {Object.keys(
        (operation?.inputSchema as ValueSchema | undefined)?.properties ?? {},
      )
        .filter((f) => f !== operation?.idempotencyArgument)
        .map((field) => (
          <label key={field}>
            {field} ← extracted field
            <select
              aria-label={`${operation?.name} mapping ${field}`}
              value={values[field] ?? ""}
              onChange={(e) => {
                const next = { ...values };
                if (e.target.value) next[field] = e.target.value;
                else delete next[field];
                set(next);
              }}
            >
              <option value="">Not mapped</option>
              {fields.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
        ))}
    </div>
  );
  async function create() {
    if (!w || !r) return;
    setBusy(true);
    setError("");
    try {
      const selected = catalog.data?.agents.find((a) => a.id === agent);
      const action = (op: NonNullable<typeof w>) =>
        workflowAction.parse({
          id: "operation",
          name: String(op.name),
          connector: "agentconnect.mcp-operation",
          connectionId: server,
          operation: op.name,
          inputSchema: op.inputSchema,
          outputSchema: op.outputSchema,
          sideEffect: op.sideEffect,
          riskLevel: op.riskLevel,
          allowSideEffects: op.sideEffect !== "read",
          idempotency: op.idempotency,
          idempotencyArgument: op.idempotencyArgument,
        });
      const setup = documentDatabaseTemplate({
        name,
        modelId: mode === "structured" ? model : undefined,
        agent:
          mode === "agent" && selected
            ? { agentId: selected.agent_id, versionId: selected.id }
            : undefined,
        outputSchema: schema,
        instruction,
        write: action(w),
        read: action(r),
        writeMappings: writeMap,
        readMappings: readMap,
        validationFields: checks,
        validationMappings: validationMap,
        maxItems,
      } as DocumentTemplateOptions);
      // Explicit final button authorizes publication of the reviewed reusable body only.
      const child = bodyId
        ? { id: bodyId, revision: 1 }
        : await requestJson<{ id: string; revision: number }>(
            `/workspaces/${workspaceId}/workflows`,
            "POST",
            { name: name + " · per-document body", graph: setup.body },
          );
      setBody(child.id);
      let version = bodyVersion;
      if (!version) {
        const published = await requestJson<{ id: string }>(
          `/workflows/${child.id}/publish`,
          "POST",
          { revision: child.revision },
        );
        version = published.id;
        setVersion(version);
      }
      const parent = await requestJson<{ id: string }>(
        `/workspaces/${workspaceId}/workflows`,
        "POST",
        { name, graph: setup.parent(child.id, version) },
      );
      onCreated(parent.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <h3>Document → Structured Database</h3>
      <p>
        A configurable starter for documents of any kind. Review one sample,
        process remaining files sequentially, write through your MCP operations,
        read back and validate selected fields. The sample is guidance; only
        remaining documents are persisted.
      </p>
      {catalog.error && <p role="alert">{catalog.error.message}</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          {bodyId && `Reusable body retained: ${bodyId}. Retry resumes setup.`}
        </p>
      )}
      <fieldset
        disabled={busy || !!bodyId}
        onChangeCapture={(e) => {
          if ((e.target as HTMLElement).id !== "document-template-review")
            setReview(false);
        }}
      >
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={70}
          />
        </label>
        <label>
          Extraction
          <select
            aria-label="Template extraction"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
          >
            <option value="structured">Structured AI</option>
            <option value="agent">
              Existing published Agent (JSON output required)
            </option>
          </select>
        </label>
        {mode === "structured" ? (
          <label>
            Model
            <select
              aria-label="Template model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              <option value="">Choose model</option>
              {catalog.data?.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            Agent version
            <select
              aria-label="Template agent"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
            >
              <option value="">Choose published Agent</option>
              {catalog.data?.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.version}
                </option>
              ))}
            </select>
          </label>
        )}
        <h4>Extracted and human-review fields</h4>
        <SchemaEditor
          value={schema}
          onChange={(value) => {
            setSchema(value);
            setChecks([]);
          }}
        />
        <label>
          Processing instruction
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            maxLength={6000}
          />
        </label>
        <label>
          MCP connection
          <select
            aria-label="Template MCP connection"
            value={server}
            onChange={(e) => {
              setServer(e.target.value);
              setWrite("");
              setRead("");
              setWriteMap({});
              setReadMap({});
            }}
          >
            <option value="">Choose configured server</option>
            {catalog.data?.connections?.mcp
              .filter((c) => c.enabled)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        {!catalog.data?.connections?.mcp.length && (
          <p>
            No MCP connections available. Configure a server and discover
            operations in Tools → MCP first.
          </p>
        )}
        <label>
          Database write operation
          <select
            aria-label="Template write operation"
            value={write}
            onChange={(e) => {
              setWrite(e.target.value);
              setWriteMap({});
            }}
          >
            <option value="">Choose explicitly allowed write</option>
            {connector?.operations
              .filter((o) => o.allowed && o.sideEffect === "write")
              .map((o) => (
                <option key={o.name} value={o.name}>
                  {o.name} · {o.riskLevel} risk
                </option>
              ))}
          </select>
        </label>
        {mappings(w, writeMap, setWriteMap)}
        <label>
          Database read-back operation
          <select
            aria-label="Template read operation"
            value={read}
            onChange={(e) => {
              setRead(e.target.value);
              setReadMap({});
            }}
          >
            <option value="">Choose read</option>
            {connector?.operations
              .filter((o) => o.allowed && o.sideEffect === "read")
              .map((o) => (
                <option key={o.name} value={o.name}>
                  {o.name}
                </option>
              ))}
          </select>
        </label>
        {mappings(r, readMap, setReadMap)}
        <h4>Validate read-back fields (all must equal extracted values)</h4>
        {fields.map((f) => (
          <label key={f}>
            <input
              type="checkbox"
              checked={checks.includes(f)}
              onChange={(e) =>
                setChecks(
                  e.target.checked
                    ? [...checks, f]
                    : checks.filter((c) => c !== f),
                )
              }
            />
            {f}
          </label>
        ))}
        {checks.map((field) => (
          <label key={field}>
            Read-back field for {field}
            <select
              aria-label={`Read-back field for ${field}`}
              value={
                validationMap[field] ?? (readPaths.includes(field) ? field : "")
              }
              onChange={(e) =>
                setValidationMap({ ...validationMap, [field]: e.target.value })
              }
            >
              <option value="">Choose read-back field</option>
              {readPaths.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label>
          Remaining document limit
          <input
            type="number"
            min={1}
            max={99}
            value={maxItems}
            onChange={(e) => setMax(Number(e.target.value))}
          />
        </label>
        <p>
          Input is configured through API/webhook settings or the canvas
          file-upload control. Native-text PDFs and text files are supported;
          scanned PDFs require existing OCR preprocessing. Five-way iteration is
          not supported: this runtime preserves sequential For Each execution.
        </p>
        <label>
          <input
            type="checkbox"
            id="document-template-review"
            checked={review}
            onChange={(e) => setReview(e.target.checked)}
          />
          I reviewed the schema, mappings, write side effects and validation.
          Publish the reusable per-document body and create the parent as a
          draft.
        </label>
      </fieldset>
      <Button
        disabled={
          busy ||
          (!bodyId &&
            (!review ||
              !w ||
              !r ||
              !checks.length ||
              !(mode === "structured" ? model : agent)))
        }
        onClick={() => void create()}
      >
        {bodyId
          ? "Retry template setup"
          : "Create template and publish reviewed body"}
      </Button>
      {bodyId && (
        <Button
          disabled={busy}
          onClick={() => {
            setBody("");
            setVersion("");
            setReview(false);
            setError(
              "Previous reusable body is retained. Review changed settings before creating another body.",
            );
          }}
        >
          Revise template settings
        </Button>
      )}
      <Button disabled={busy} onClick={onCancel}>
        Cancel template
      </Button>
    </section>
  );
}
