"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import type { Model } from "./agent-studio";
export type RerankerOption = {
  id: string;
  name: string;
  provider: "llm" | "cohere";
  model_id: string;
  model_configuration_id: string | null;
  enabled: boolean;
  available: boolean;
  revision: number;
};
type Form = {
  name: string;
  provider: "llm" | "cohere";
  modelConfigurationId: string | null;
  modelId: string;
  baseUrl: string;
  secretId: string | null;
  enabled: boolean;
  revision?: number;
};
const empty: Form = {
  name: "",
  provider: "llm",
  modelConfigurationId: null,
  modelId: "rerank-v3.5",
  baseUrl: "https://api.cohere.com",
  secretId: null,
  enabled: true,
};
export function RerankerRegistry({
  workspaceId,
  canManage,
  models,
}: {
  workspaceId: string;
  canManage: boolean;
  models: Model[];
}) {
  const cache = useQueryClient(),
    base = `/workspaces/${workspaceId}/rerankers`;
  const rows = useQuery({
    queryKey: ["rerankers", workspaceId],
    queryFn: () => requestJson<RerankerOption[]>(base),
  });
  const secrets = useQuery({
    queryKey: ["secrets", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/secrets`,
      ),
    enabled: canManage,
  });
  const [form, setForm] = useState<Form | null>(null),
    [editing, setEditing] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await cache.invalidateQueries({ queryKey: ["rerankers", workspaceId] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to update reranker");
    } finally {
      setBusy(false);
    }
  }
  async function edit(row: RerankerOption) {
    await run(async () => {
      const d = await requestJson<{
        name: string;
        provider: "llm" | "cohere";
        model_configuration_id: string | null;
        model_id: string;
        base_url: string;
        secret_id: string | null;
        enabled: boolean;
        revision: number;
      }>(`${base}/${row.id}`);
      setEditing(row.id);
      setForm({
        name: d.name,
        provider: d.provider,
        modelConfigurationId: d.model_configuration_id,
        modelId: d.model_id || "rerank-v3.5",
        baseUrl: d.base_url,
        secretId: d.secret_id,
        enabled: d.enabled,
        revision: d.revision,
      });
    });
  }
  return (
    <section className="panel reranker-registry">
      <div className="panel-header">
        <div>
          <h3>Rerankers</h3>
          <p className="muted">
            Approve a separate model for ranking retrieved knowledge.
          </p>
        </div>
        {canManage && (
          <Button
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setForm({ ...empty });
            }}
          >
            Register reranker
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {rows.isError && (
        <p role="alert">
          Unable to load rerankers.{" "}
          <Button onClick={() => void rows.refetch()}>Retry</Button>
        </p>
      )}
      {form && (
        <form
          className="studio-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await requestJson(
                editing ? `${base}/${editing}` : base,
                editing ? "PUT" : "POST",
                {
                  ...form,
                  modelConfigurationId:
                    form.provider === "llm" ? form.modelConfigurationId : null,
                  secretId: form.provider === "cohere" ? form.secretId : null,
                },
              );
              setForm(null);
            });
          }}
        >
          <label>
            Reranker name
            <input
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            Reranker provider
            <select
              aria-label="Reranker provider"
              value={form.provider}
              onChange={(e) =>
                setForm({
                  ...form,
                  provider: e.target.value as Form["provider"],
                })
              }
            >
              <option value="llm">Registered language model</option>
              <option value="cohere">Cohere rerank API</option>
            </select>
          </label>
          {form.provider === "llm" ? (
            <label>
              Reranking model
              <select
                required
                aria-label="Reranking model"
                value={form.modelConfigurationId ?? ""}
                onChange={(e) =>
                  setForm({
                    ...form,
                    modelConfigurationId: e.target.value || null,
                  })
                }
              >
                <option value="">Select a model</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} · {m.model_id}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label>
                Reranker model identifier
                <input
                  required
                  value={form.modelId}
                  maxLength={150}
                  onChange={(e) =>
                    setForm({ ...form, modelId: e.target.value })
                  }
                />
              </label>
              <label>
                Cohere base URL
                <input
                  type="url"
                  required
                  value={form.baseUrl}
                  onChange={(e) =>
                    setForm({ ...form, baseUrl: e.target.value })
                  }
                />
              </label>
              <label>
                Reranker workspace credential
                <select
                  required
                  aria-label="Reranker workspace credential"
                  value={form.secretId ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, secretId: e.target.value || null })
                  }
                >
                  <option value="">Select a Cohere API key</option>
                  {secrets.data?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <details className="configure-details">
                <summary>Connection settings</summary>
                <p>
                  Save the API key in workspace Secrets. The API must approve
                  this hostname in RERANK_ALLOWED_HOSTS. Cohere uses its native
                  /v2/rerank API.
                </p>
              </details>
            </>
          )}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            Enabled
          </label>
          <div className="studio-actions">
            <Button disabled={busy}>Save reranker</Button>
            <Button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setForm(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {!rows.isLoading && !rows.data?.length && (
        <p className="empty">
          No separate rerankers registered. Agents can use their answer model.
        </p>
      )}
      {rows.data?.map((row) => (
        <div className="reranker-row" key={row.id}>
          <div>
            <strong>{row.name}</strong>
            <p className="muted">
              {row.provider === "cohere" ? "Cohere" : "Language model"} ·{" "}
              {row.available ? "Available" : "Unavailable"}
            </p>
          </div>
          {canManage && (
            <div className="studio-actions">
              <Button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void edit(row)}
              >
                Edit
              </Button>
              <Button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove ${row.name}? Agents using it will keep retrieval order until another reranker is selected.`,
                    )
                  )
                    void run(() => requestJson(`${base}/${row.id}`, "DELETE"));
                }}
              >
                Remove
              </Button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
