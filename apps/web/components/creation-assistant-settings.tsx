"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";
export type CreationSettings = {
  enabled: boolean;
  modelId: string | null;
  modelName?: string;
  available: boolean;
  revision: number;
};
export function CreationAssistantSettings({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: string;
}) {
  const cache = useQueryClient();
  const settings = useQuery({
    queryKey: ["creation-settings", workspaceId],
    queryFn: () =>
      requestJson<CreationSettings>(
        `/workspaces/${workspaceId}/creation-settings`,
      ),
  });
  const models = useQuery({
    queryKey: ["models", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/models`,
      ),
  });
  const [edit, setEdit] = useState<{
    enabled: boolean;
    modelId: string | null;
    revision: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const manage = ["owner", "org_admin", "workspace_admin"].includes(role);
  const value = edit ?? settings.data;
  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>Creation assistant</h2>
          <p>Choose the AI that helps your team build agents and workflows.</p>
        </div>
      </div>
      {(error || settings.error || models.error) && (
        <p role="alert" className="error-banner">
          {error || settings.error?.message || models.error?.message}
        </p>
      )}
      {settings.isPending ? (
        <p role="status">Loading settings…</p>
      ) : (
        value && (
          <form
            className="creation-settings-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              try {
                await requestJson(
                  `/workspaces/${workspaceId}/creation-settings`,
                  "PUT",
                  {
                    enabled: value.enabled,
                    modelId: value.modelId,
                    revision: value.revision,
                  },
                );
                await cache.invalidateQueries({
                  queryKey: ["creation-settings", workspaceId],
                });
                setEdit(null);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <fieldset disabled={!manage || busy}>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={value.enabled}
                  onChange={(e) =>
                    setEdit({
                      enabled: e.target.checked,
                      modelId: value.modelId,
                      revision: value.revision,
                    })
                  }
                />
                Enable AI-guided creation
                <HelpTooltip label="About AI-guided creation">
                  Builders can chat with this model to propose configurations.
                  Resource names and creation messages are sent to the selected
                  provider. Drafts require review; nothing is published
                  automatically. Manual setup remains available.
                </HelpTooltip>
              </label>
              <label>
                Assistant model
                <select
                  aria-label="Assistant model"
                  value={value.modelId ?? ""}
                  onChange={(e) =>
                    setEdit({
                      enabled: value.enabled,
                      modelId: e.target.value || null,
                      revision: value.revision,
                    })
                  }
                >
                  <option value="">Select a workspace model</option>
                  {value.modelId &&
                    !models.data?.some((m) => m.id === value.modelId) && (
                      <option value={value.modelId}>
                        Unavailable model — select a replacement
                      </option>
                    )}
                  {models.data?.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <small>
                The creation assistant model is separate from each agent’s
                runtime model. Register and test models in Models first.
              </small>
              <div className="studio-actions">
                <Button disabled={!edit || (value.enabled && !value.modelId)}>
                  Save assistant settings
                </Button>
                <Button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setEdit(null);
                    setError("");
                    void settings.refetch();
                  }}
                >
                  Reload settings
                </Button>
              </div>
            </fieldset>
            {!edit && settings.data && (
              <p role="status">
                {settings.data.enabled && settings.data.available
                  ? `Ready · ${settings.data.modelName}`
                  : "AI creation is not configured. Manual setup is available."}
              </p>
            )}
            {!manage && (
              <p className="muted">
                Ask a workspace administrator to change these settings.
              </p>
            )}
          </form>
        )
      )}
    </section>
  );
}
