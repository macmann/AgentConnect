"use client";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { permitted, type Role } from "@agentconnect/schemas/foundation";
import {
  handoffPolicy,
  type HandoffPolicy,
  type SupportPage,
  type SupportQueue,
  type SupportSkill,
} from "@agentconnect/schemas/support";
import { Button } from "./button";
import { requestJson } from "./agent-client";
type Target = { id: string; name: string };
type PolicyResponse = {
  policy: HandoffPolicy;
  source: string;
  revision: number;
  override: HandoffPolicy | null;
};
export function SupportPolicy({
  workspaceId,
  role,
  onDraftChange,
}: {
  workspaceId: string;
  role: Role;
  onDraftChange: (dirty: boolean) => void;
}) {
  const base = `/workspaces/${workspaceId}/support`,
    cache = useQueryClient(),
    canEdit = permitted(role, "support:queue:manage");
  const [scope, setScope] = useState("workspace"),
    [target, setTarget] = useState(""),
    [value, setValue] = useState<HandoffPolicy>(handoffPolicy.parse({})),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const targets = useQuery({
    queryKey: ["support", workspaceId, "policy-targets"],
    queryFn: () =>
      requestJson<{
        agents: Target[];
        deployments: Target[];
        models: Target[];
      }>(base + "/policy/targets"),
  });
  async function pages<T>(resource: string) {
    const items: T[] = [];
    let suffix = "";
    do {
      const p = await requestJson<SupportPage<T>>(
        base + "/" + resource + "?limit=100" + suffix,
      );
      items.push(...p.items);
      suffix = p.nextCursor
        ? "&before=" +
          encodeURIComponent(p.nextCursor.before) +
          "&beforeId=" +
          p.nextCursor.beforeId
        : "";
    } while (suffix);
    return items;
  }
  const queues = useQuery({
    queryKey: ["support", workspaceId, "policy-queues"],
    queryFn: () => pages<SupportQueue>("queues"),
  });
  const skills = useQuery({
    queryKey: ["support", workspaceId, "policy-skills"],
    queryFn: () => pages<SupportSkill>("skills"),
  });
  const query = "?scope=" + scope + (target ? "&targetId=" + target : "");
  const policy = useQuery({
    queryKey: ["support", workspaceId, "policy", scope, target],
    queryFn: () => requestJson<PolicyResponse>(base + "/policy" + query),
    enabled: scope === "workspace" || !!target,
  });
  useEffect(() => {
    if (policy.data && !dirty) {
      setValue(policy.data.policy);
    }
  }, [policy.data, dirty]);
  useEffect(() => {
    onDraftChange(dirty);
    return () => onDraftChange(false);
  }, [dirty, onDraftChange]);
  function update<K extends keyof HandoffPolicy>(
    key: K,
    next: HandoffPolicy[K],
  ) {
    setValue((v) => ({ ...v, [key]: next }));
    setDirty(true);
    setNotice("");
  }
  function changeScope(next: string) {
    if (dirty && !window.confirm("Discard unsaved policy changes?")) return;
    setScope(next);
    setTarget("");
    setDirty(false);
    setError("");
    setNotice("");
  }
  async function save(reset = false) {
    setBusy(true);
    setError("");
    try {
      if (!reset) handoffPolicy.parse(value);
      await requestJson(
        base + "/policy" + query,
        reset ? "DELETE" : "PUT",
        reset ? undefined : value,
      );
      setDirty(false);
      await cache.invalidateQueries({
        queryKey: ["support", workspaceId, "policy"],
      });
      setNotice(
        reset
          ? "Override removed. Inherited policy restored."
          : "Handoff policy saved. Applies to subsequent offers and confirmations.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const unavailable =
    policy.isLoading ||
    policy.isError ||
    !policy.data ||
    targets.isError ||
    queues.isError ||
    skills.isError;
  return (
    <section className="panel support-policy" aria-label="Handoff policy">
      <div className="panel-heading">
        <div>
          <h3>Handoff policy</h3>
          <p>
            Choose when customers can reach a specialist and how AI prepares the
            handoff.
          </p>
        </div>
      </div>
      <div className="support-policy-scope">
        <label>
          Policy scope
          <select
            aria-label="Policy scope"
            value={scope}
            disabled={busy}
            onChange={(e) => changeScope(e.target.value)}
          >
            <option value="workspace">Workspace defaults</option>
            <option value="agent">Agent override</option>
            <option value="deployment">Deployment override</option>
          </select>
        </label>
        {scope !== "workspace" && (
          <label>
            {scope === "agent" ? "Agent" : "Deployment"}
            <select
              aria-label={scope === "agent" ? "Agent" : "Deployment"}
              value={target}
              disabled={busy}
              onChange={(e) => {
                if (dirty && !window.confirm("Discard unsaved policy changes?"))
                  return;
                setTarget(e.target.value);
                setDirty(false);
              }}
            >
              <option value="">Choose {scope}</option>
              {(scope === "agent"
                ? targets.data?.agents
                : targets.data?.deployments
              )?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {scope !== "workspace" && !target ? (
        <p>
          Select a {scope} to review its inherited policy. Complete overrides
          take precedence: deployment → agent → workspace → defaults.
        </p>
      ) : policy.isLoading ? (
        <p role="status">Loading policy…</p>
      ) : policy.isError ? (
        <>
          <p className="error" role="alert">
            {policy.error.message}
          </p>
          <Button onClick={() => void policy.refetch()}>Retry policy</Button>
        </>
      ) : (
        <>
          <p className="muted">
            Using {policy.data?.source} policy
            {policy.data?.revision ? " · revision " + policy.data.revision : ""}
            . Saving creates a complete override at the selected scope.
          </p>
          <fieldset disabled={!canEdit || busy || unavailable}>
            <legend className="sr-only">Escalation settings</legend>
            <div className="support-policy-grid">
              <label>
                Human access
                <select
                  aria-label="Human access"
                  value={value.humanEntryMode}
                  onChange={(e) =>
                    update(
                      "humanEntryMode",
                      e.target.value as HandoffPolicy["humanEntryMode"],
                    )
                  }
                >
                  <option value="policy_controlled">
                    AI-controlled offers
                  </option>
                  <option value="always_available">Always available</option>
                  <option value="disabled">Disabled</option>
                </select>
                <small>
                  AI-controlled offers require customer confirmation. Repeated
                  requests are honored at the threshold below.
                </small>
              </label>
              <label>
                Explicit requests before offer
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={value.explicitRequestThreshold}
                  onChange={(e) =>
                    update("explicitRequestThreshold", Number(e.target.value))
                  }
                />
              </label>
              <label>
                Unsuccessful attempts before offer
                <input
                  type="number"
                  min={2}
                  max={10}
                  value={value.maxResolutionAttempts}
                  onChange={(e) =>
                    update("maxResolutionAttempts", Number(e.target.value))
                  }
                />
              </label>
              <label>
                Tool failures before offer
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={value.toolFailureThreshold}
                  onChange={(e) =>
                    update("toolFailureThreshold", Number(e.target.value))
                  }
                />
              </label>
              <label>
                Default queue
                <select
                  aria-label="Default queue"
                  value={value.defaultQueueId ?? ""}
                  onChange={(e) =>
                    update("defaultQueueId", e.target.value || null)
                  }
                >
                  <option value="">Use workspace default queue</option>
                  {queues.data
                    ?.filter((q) => q.enabled || q.id === value.defaultQueueId)
                    .map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.name}
                        {!q.enabled ? " (disabled)" : ""}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Default priority
                <select
                  aria-label="Default priority"
                  value={value.defaultPriority}
                  onChange={(e) =>
                    update(
                      "defaultPriority",
                      e.target.value as HandoffPolicy["defaultPriority"],
                    )
                  }
                >
                  {["low", "normal", "high", "urgent"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Triage model
                <select
                  aria-label="Triage model"
                  value={value.triageModelId ?? ""}
                  onChange={(e) =>
                    update("triageModelId", e.target.value || null)
                  }
                >
                  <option value="">Use conversation model</option>
                  {targets.data?.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <small>
                  The model receives a bounded transcript and tool status
                  metadata, excluding private notes.
                </small>
              </label>
              <label>
                Triage output token budget
                <input
                  type="number"
                  min={256}
                  max={8192}
                  value={value.maxOutputTokens}
                  onChange={(e) =>
                    update("maxOutputTokens", Number(e.target.value))
                  }
                />
              </label>
            </div>
            <div className="support-policy-checks">
              {(
                [
                  [
                    "loopDetectionEnabled",
                    "Detect repeated questions and failed resolution attempts",
                  ],
                  [
                    "toolFailureEscalationEnabled",
                    "Offer support after repeated tool failures",
                  ],
                  ["agentCanRequestHandoff", "Allow AI to recommend a handoff"],
                  [
                    "sentimentEscalationEnabled",
                    "Evaluate persistent frustration",
                  ],
                  ["aiTriageEnabled", "Generate structured routing triage"],
                  [
                    "generateHandoffSummary",
                    "Generate a private handoff brief",
                  ],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={value[key]}
                    onChange={(e) => update(key, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
            </div>
            <p className="muted">
              AI recommendations, frustration analysis and intent rules add a
              bounded model decision call to each chat turn. Handoff triage runs
              once per case; operators can refresh manually. Provider failure
              falls back to the queue and raw transcript.
            </p>
            <h4>Intents requiring human support</h4>
            <p>
              Match a structured AI intent to an approved queue and mandatory
              skills. Model-generated skill names are preferences; these rules
              enforce requirements.
            </p>
            {value.intentRules.map((r, i) => (
              <div className="support-intent-rule" key={i}>
                <label>
                  Intent
                  <input
                    value={r.intent}
                    maxLength={80}
                    onChange={(e) =>
                      update(
                        "intentRules",
                        value.intentRules.map((v, j) =>
                          j === i ? { ...v, intent: e.target.value } : v,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Queue
                  <select
                    value={r.queueId ?? ""}
                    onChange={(e) =>
                      update(
                        "intentRules",
                        value.intentRules.map((v, j) =>
                          j === i
                            ? { ...v, queueId: e.target.value || null }
                            : v,
                        ),
                      )
                    }
                  >
                    <option value="">Default queue</option>
                    {queues.data
                      ?.filter((q) => q.enabled)
                      .map((q) => (
                        <option key={q.id} value={q.id}>
                          {q.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  Priority
                  <select
                    value={r.priority}
                    onChange={(e) =>
                      update(
                        "intentRules",
                        value.intentRules.map((v, j) =>
                          j === i
                            ? {
                                ...v,
                                priority: e.target.value as typeof r.priority,
                              }
                            : v,
                        ),
                      )
                    }
                  >
                    {["low", "normal", "high", "urgent"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Required skills
                  <select
                    multiple
                    value={r.requiredSkills}
                    onChange={(e) =>
                      update(
                        "intentRules",
                        value.intentRules.map((v, j) =>
                          j === i
                            ? {
                                ...v,
                                requiredSkills: Array.from(
                                  e.target.selectedOptions,
                                  (o) => o.value,
                                ),
                              }
                            : v,
                        ),
                      )
                    }
                  >
                    {skills.data
                      ?.filter((s) => s.enabled)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </label>
                <Button
                  type="button"
                  className="secondary"
                  onClick={() =>
                    update(
                      "intentRules",
                      value.intentRules.filter((_, j) => j !== i),
                    )
                  }
                >
                  Remove rule
                </Button>
              </div>
            ))}
            <Button
              type="button"
              className="secondary"
              disabled={value.intentRules.length >= 20}
              onClick={() =>
                update("intentRules", [
                  ...value.intentRules,
                  {
                    intent: "",
                    queueId: null,
                    priority: "normal",
                    requiredSkills: [],
                  },
                ])
              }
            >
              Add intent rule
            </Button>
          </fieldset>
          {canEdit ? (
            <div className="support-policy-actions">
              <Button
                disabled={busy || unavailable || !dirty}
                onClick={() => void save()}
              >
                {busy ? "Saving…" : "Save policy"}
              </Button>
              {policy.data?.override && (
                <Button
                  className="secondary"
                  disabled={busy || unavailable}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Remove this override and use the inherited policy?",
                      )
                    )
                      void save(true);
                  }}
                >
                  Reset to inherited policy
                </Button>
              )}
              {dirty && <span>Unsaved changes</span>}
            </div>
          ) : (
            <p>Ask a workspace administrator to change this policy.</p>
          )}
        </>
      )}
      {(targets.isError || queues.isError || skills.isError) && (
        <p className="error" role="alert">
          Policy options could not load.{" "}
          <button
            type="button"
            onClick={() => {
              void targets.refetch();
              void queues.refetch();
              void skills.refetch();
            }}
          >
            Retry options
          </button>
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
