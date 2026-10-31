"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { requestJson, apiBase } from "./agent-client";
import {
  SchemaEditor,
  StructuredFields,
  type ValueSchema,
} from "./workflow-v2-fields";
import { Button } from "./button";
type Hook = {
  id: string;
  name: string;
  version_id: string;
  input_schema: ValueSchema;
  sample: unknown;
  enabled: boolean;
  expires_at: string;
  revision: number;
  endpoint: string;
};
export function WorkflowWebhooks({
  workflowId,
  versions,
  canManage,
}: {
  workflowId: string;
  versions: { id: string; version: number }[];
  canManage: boolean;
}) {
  const list = useQuery({
    queryKey: ["workflow-webhooks", workflowId],
    queryFn: () => requestJson<Hook[]>(`/workflows/${workflowId}/webhooks`),
  });
  const [name, setName] = useState("Workflow webhook"),
    [versionId, setVersion] = useState(versions[0]?.id ?? ""),
    [schema, setSchema] = useState<ValueSchema>({
      type: "object",
      properties: {},
    }),
    [sample, setSample] = useState<unknown>({}),
    [days, setDays] = useState(90),
    [enabled, setEnabled] = useState(true),
    [editing, setEditing] = useState<Hook | null>(null),
    [issued, setIssued] = useState<{ token: string; endpoint: string } | null>(
      null,
    ),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await list.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="configure-group">
      <summary>Webhook triggers</summary>
      <p>
        Accept authenticated JSON requests and expose their data through Trigger
        → body. Each endpoint runs a published workflow version.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {list.error && <p role="alert">{list.error.message}</p>}
      {list.data?.map((h) => (
        <fieldset key={h.id}>
          <legend>
            {h.name} · {h.enabled ? "enabled" : "disabled"}
          </legend>
          <p style={{ overflowWrap: "anywhere" }}>
            {apiBase}
            {h.endpoint}
          </p>
          <small>Expires {new Date(h.expires_at).toLocaleString()}</small>
          {canManage && (
            <div className="v2-inline">
              <Button
                onClick={() => {
                  setEditing(h);
                  setName(h.name);
                  setVersion(h.version_id);
                  setSchema(h.input_schema);
                  setSample(h.sample);
                  setEnabled(h.enabled);
                  setIssued(null);
                }}
              >
                Configure webhook
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const r = await requestJson<{ token: string }>(
                      `/workflows/${workflowId}/webhooks/${h.id}/rotate`,
                      "POST",
                    );
                    setIssued({ token: r.token, endpoint: h.endpoint });
                    setNotice(
                      "Webhook token rotated; the old token no longer works. Expiry is unchanged.",
                    );
                  })
                }
              >
                Rotate token
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const r = await requestJson<{ id: string }>(
                      `/workflows/${workflowId}/webhooks/${h.id}/test`,
                      "POST",
                      { input: h.sample },
                    );
                    setNotice(
                      `Sample queued as run ${r.id}. Open Test / runs to inspect it.`,
                    );
                  })
                }
              >
                Test request sample
              </Button>
            </div>
          )}
        </fieldset>
      ))}
      {issued && (
        <fieldset>
          <legend>Webhook credential · shown only now</legend>
          <p style={{ overflowWrap: "anywhere" }}>
            POST {apiBase}
            {issued.endpoint}
          </p>
          <label>
            Webhook bearer token
            <input type="password" value={issued.token} readOnly />
          </label>
          <Button
            onClick={() =>
              void act(async () => {
                await navigator.clipboard.writeText(issued.token);
                setNotice("Webhook token copied");
              })
            }
          >
            Copy webhook token
          </Button>
          <p>
            Send this token in the Authorization header. Keep it in the calling
            integration’s secret store.
          </p>
        </fieldset>
      )}
      {canManage && (
        <fieldset disabled={busy || !versions.length}>
          <legend>{editing ? "Edit webhook" : "New webhook"}</legend>
          {!versions.length && (
            <p>Publish a workflow version to create a webhook trigger.</p>
          )}
          <label>
            Webhook name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Published workflow version
            <select
              aria-label="Webhook workflow version"
              value={versionId}
              onChange={(e) => setVersion(e.target.value)}
            >
              <option value="">Choose published version</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  Version {v.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            Expires in days
            <input
              type="number"
              min="1"
              max="365"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Webhook enabled
          </label>
          <h4>Request schema</h4>
          <SchemaEditor value={schema} onChange={setSchema} />
          <h4>Request sample / test data</h4>
          <StructuredFields
            schema={schema}
            value={sample}
            onChange={setSample}
            label="Sample request"
          />
          <Button
            disabled={!name || !versionId}
            onClick={() =>
              void act(async () => {
                const response = await requestJson<{
                  token?: string;
                  endpoint?: string;
                }>(
                  editing
                    ? `/workflows/${workflowId}/webhooks/${editing.id}`
                    : `/workflows/${workflowId}/webhooks`,
                  editing ? "PUT" : "POST",
                  {
                    name,
                    versionId,
                    inputSchema: schema,
                    sample,
                    enabled,
                    expiresInDays: days,
                    ...(editing ? { revision: editing.revision } : {}),
                  },
                );
                if (response.token)
                  setIssued({
                    token: response.token,
                    endpoint: response.endpoint!,
                  });
                setEditing(null);
                setNotice("Webhook saved");
              })
            }
          >
            Save webhook trigger
          </Button>
          {editing && (
            <Button onClick={() => setEditing(null)}>
              Create another webhook
            </Button>
          )}
        </fieldset>
      )}
    </details>
  );
}
