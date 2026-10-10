"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  routingMode,
  routingPolicy,
  type SupportQueue,
  type OperatorProfile,
  type SupportSkill,
} from "@agentconnect/schemas/support";
import { SupportEditorFrame } from "./support-team";
import { requestJson } from "./agent-client";
import { statusLabel } from "./support-utils";
import { Button } from "./button";
type Member = {
  user_id: string;
  enabled: boolean;
  priority_weight: number;
  name: string;
};
export function SupportQueueEditor({
  q,
  base,
  workspaceId,
  profiles,
  skills,
  onClose,
  onSaved,
}: {
  q: SupportQueue;
  base: string;
  workspaceId: string;
  profiles: OperatorProfile[];
  skills: SupportSkill[];
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const current = useQuery({
    queryKey: ["support", workspaceId, "members", q.id],
    queryFn: () =>
      requestJson<{ items: Member[] }>(`${base}/queues/${q.id}/members`),
  });
  const [members, setMembers] = useState<Member[] | null>(null),
    [strategy, setStrategy] = useState(q.routing_strategy),
    [mode, setMode] = useState(q.assignment_mode),
    [isDefault, setDefault] = useState(q.is_default),
    [enabled, setEnabled] = useState(q.enabled),
    [policy, setPolicy] = useState(() => routingPolicy.parse(q.routing_config)),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const rows = members ?? current.data?.items ?? [],
    allProfiles = [
      ...profiles.map((p) => ({ id: p.user_id, name: p.name })),
      ...rows
        .filter((m) => !profiles.some((p) => p.user_id === m.user_id))
        .map((m) => ({ id: m.user_id, name: m.name })),
    ];
  return (
    <SupportEditorFrame
      title={`Routing: ${q.name}`}
      description="Required skills and languages are hard eligibility constraints. Automatic assignment still requires operator acceptance."
      onClose={onClose}
      busy={busy}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await requestJson(`${base}/queues/${q.id}`, "PATCH", {
              routingStrategy: strategy,
              assignmentMode: mode,
              isDefault,
              enabled,
              routingConfig: policy,
              members: rows.map((m) => ({
                userId: m.user_id,
                enabled: m.enabled,
                priorityWeight: m.priority_weight,
              })),
            });
            await onSaved();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy || current.isPending || !!current.error}>
          <div className="form-grid">
            <label>
              Routing strategy
              <select
                aria-label="Routing strategy"
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as typeof strategy)}
              >
                {routingMode.options.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Assignment mode
              <select
                aria-label="Assignment mode"
                value={mode}
                onChange={(e) => setMode(e.target.value as typeof mode)}
              >
                <option value="manual">Manual</option>
                <option value="recommend">Recommend</option>
                <option value="automatic">Automatic</option>
              </select>
            </label>
            <label>
              Required language
              <input
                placeholder="e.g. my"
                value={policy.requiredLanguage ?? ""}
                onChange={(e) =>
                  setPolicy((p) => ({
                    ...p,
                    requiredLanguage: e.target.value || null,
                  }))
                }
              />
            </label>
            <label>
              Preferred language
              <input
                placeholder="e.g. en"
                value={policy.preferredLanguage ?? ""}
                onChange={(e) =>
                  setPolicy((p) => ({
                    ...p,
                    preferredLanguage: e.target.value || null,
                  }))
                }
              />
            </label>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Queue enabled
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(e) => setDefault(e.target.checked)}
            />
            Default queue for new support requests
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={policy.continuity}
              onChange={(e) =>
                setPolicy((p) => ({ ...p, continuity: e.target.checked }))
              }
            />
            Prefer the previous specialist on this conversation
          </label>
          {strategy === "manual" && mode !== "manual" && (
            <p className="field-help">
              Choose an automated strategy to enable recommendations or
              automatic assignment.
            </p>
          )}
          <h3>Queue members</h3>
          {current.isPending && <p role="status">Loading queue members…</p>}
          {!allProfiles.length && (
            <p>Add operator profiles first, then reopen this queue.</p>
          )}
          <div className="support-member-picker">
            {allProfiles.map((p) => {
              const m = rows.find((x) => x.user_id === p.id);
              return (
                <div key={p.id}>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      aria-label={`Queue member ${p.name}`}
                      checked={!!m}
                      onChange={(e) =>
                        setMembers(
                          e.target.checked
                            ? [
                                ...rows,
                                {
                                  user_id: p.id,
                                  name: p.name,
                                  enabled: true,
                                  priority_weight: 1,
                                },
                              ]
                            : rows.filter((x) => x.user_id !== p.id),
                        )
                      }
                    />
                    {p.name}
                  </label>
                  {m && (
                    <>
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          aria-label={`Enabled member ${p.name}`}
                          checked={m.enabled}
                          onChange={(e) =>
                            setMembers(
                              rows.map((x) =>
                                x.user_id === p.id
                                  ? { ...x, enabled: e.target.checked }
                                  : x,
                              ),
                            )
                          }
                        />
                        Enabled
                      </label>
                      <label>
                        Queue weight
                        <input
                          aria-label={`Queue weight ${p.name}`}
                          type="number"
                          min={1}
                          max={10}
                          required
                          value={m.priority_weight}
                          onChange={(e) =>
                            setMembers(
                              rows.map((x) =>
                                x.user_id === p.id
                                  ? {
                                      ...x,
                                      priority_weight: Number(e.target.value),
                                    }
                                  : x,
                              ),
                            )
                          }
                        />
                      </label>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <h3>Skill requirements</h3>
          <div className="support-skill-picker">
            {!skills.length && (
              <p>Create reusable skills in the Skills section.</p>
            )}
            {skills
              .filter(
                (s) =>
                  s.enabled ||
                  policy.requiredSkills.includes(s.id) ||
                  policy.preferredSkills.includes(s.id),
              )
              .map((s) => (
                <label key={s.id}>
                  {s.name}
                  {!s.enabled ? " (disabled)" : ""}
                  <select
                    aria-label={`Queue skill ${s.name}`}
                    value={
                      policy.requiredSkills.includes(s.id)
                        ? "required"
                        : policy.preferredSkills.includes(s.id)
                          ? "preferred"
                          : "none"
                    }
                    onChange={(e) =>
                      setPolicy((p) => ({
                        ...p,
                        requiredSkills: [
                          ...p.requiredSkills.filter((id) => id !== s.id),
                          ...(e.target.value === "required" ? [s.id] : []),
                        ],
                        preferredSkills: [
                          ...p.preferredSkills.filter((id) => id !== s.id),
                          ...(e.target.value === "preferred" ? [s.id] : []),
                        ],
                      }))
                    }
                  >
                    <option value="none">Not used</option>
                    <option value="required">Required</option>
                    <option value="preferred">Preferred</option>
                  </select>
                </label>
              ))}
          </div>
          {strategy === "hybrid" && (
            <>
              <h3>Hybrid scoring weights</h3>
              <p className="field-help">
                Each factor is normalized from 0 to 1 and multiplied by its
                weight. Fairness reaches 1 after an hour without a queue
                assignment.
              </p>
              <div className="support-weight-grid">
                {Object.entries(policy.weights).map(([key, value]) => (
                  <label key={key}>
                    {statusLabel(key)} weight
                    <input
                      aria-label={`${statusLabel(key)} scoring weight`}
                      type="number"
                      min={0}
                      max={100}
                      required
                      value={value}
                      onChange={(e) =>
                        setPolicy((p) => ({
                          ...p,
                          weights: {
                            ...p.weights,
                            [key]: Number(e.target.value),
                          },
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
            </>
          )}
        </fieldset>
        {current.error && (
          <p role="alert" className="error">
            {current.error.message}
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <Button
            className="secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={busy || current.isPending || !!current.error}
          >
            {busy ? "Saving…" : "Save queue routing"}
          </Button>
        </div>
      </form>
    </SupportEditorFrame>
  );
}
