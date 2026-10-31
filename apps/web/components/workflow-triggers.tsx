"use client";
import { WorkflowWebhooks } from "./workflow-webhooks";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { WorkflowGraph } from "@agentconnect/schemas/workflows";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";
import { requestJson, apiBase } from "./agent-client";
import { WorkflowRunFields } from "./workflow-inputs";
type Version = { id: string; version: number; graph: WorkflowGraph };
type Schedule = {
  id: string;
  name: string;
  version_id: string;
  cron: string;
  timezone: string;
  input: string;
  enabled: boolean;
  overlap_policy: "skip" | "allow";
  missed_policy: "skip" | "run_once";
  revision: number;
  next_run_at: string;
  last_run_at: string | null;
  last_error: string | null;
};
export function WorkflowTriggers({
  workflowId,
  workspaceId,
  versions,
  canManage,
}: {
  workflowId: string;
  workspaceId: string;
  versions: Version[];
  canManage: boolean;
}) {
  const list = useQuery({
    queryKey: ["workflow-schedules", workflowId],
    queryFn: () =>
      requestJson<Schedule[]>(`/workflows/${workflowId}/schedules`),
    refetchInterval: 15000,
  });
  const [editing, setEditing] = useState<Schedule | null>(null),
    [name, setName] = useState("Daily workflow"),
    [version, setVersion] = useState(versions[0]?.id ?? ""),
    [frequency, setFrequency] = useState("daily"),
    [hour, setHour] = useState("8"),
    [minute, setMinute] = useState("0"),
    [weekday, setWeekday] = useState("1"),
    [custom, setCustom] = useState("0 8 * * *"),
    [zone, setZone] = useState(
      () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    ),
    [input, setInput] = useState(""),
    [overlap, setOverlap] = useState("skip"),
    [missed, setMissed] = useState("skip"),
    [enabled, setEnabled] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [preview, setPreview] = useState<string[]>([]),
    [notice, setNotice] = useState("");
  const cron =
    frequency === "daily"
      ? `${minute} ${hour} * * *`
      : frequency === "weekly"
        ? `${minute} ${hour} * * ${weekday}`
        : custom;
  const fields =
    versions.find((v) => v.id === version)?.graph.inputFields ?? [];
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function load(s: Schedule) {
    setEditing(s);
    setName(s.name);
    setVersion(s.version_id);
    setFrequency("custom");
    setCustom(s.cron);
    setZone(s.timezone);
    setInput(s.input);
    setOverlap(s.overlap_policy);
    setMissed(s.missed_policy);
    setEnabled(s.enabled);
    setPreview([]);
  }
  return (
    <section className="panel-body workflow-triggers">
      <h3>Workflow triggers</h3>
      <WorkflowWebhooks
        workflowId={workflowId}
        versions={versions}
        canManage={canManage}
      />
      <p>Run a published workflow from your application or on a schedule.</p>
      <details className="configure-group">
        <summary>API invocation</summary>
        <p>
          Create a workflow-scoped key in{" "}
          <a href={`/#view=Operations&workspace=${workspaceId}`}>
            Operations → API keys
          </a>
          . Store it on your server.
        </p>
        <pre>{`POST ${apiBase}/api/v1/workflows/${workflowId}/runs\nAuthorization: Bearer <workflow-key>\nIdempotency-Key: <unique-request-id>\nContent-Type: application/json\n\n${JSON.stringify({ versionId: versions[0]?.id ?? "<published-version-id>", input: fields.length ? Object.fromEntries(fields.map((f) => [f.name, f.defaultValue ?? (f.type === "number" ? 0 : f.type === "boolean" ? false : f.type === "json" ? {} : "value")])) : "Your workflow input" }, null, 2)}`}</pre>
        <p>
          The API returns a run ID. Poll{" "}
          <code>/api/v1/workflows/{workflowId}/runs/:runId</code> for status and
          results. Reusing an idempotency key with the same request returns the
          same run.
        </p>
      </details>
      <h4>Schedules</h4>
      {list.error && <p role="alert">{list.error.message}</p>}
      {!list.data?.length && <p>No schedules configured.</p>}
      <div className="workflow-schedule-list">
        {list.data?.map((s) => (
          <article className="configure-group" key={s.id}>
            <h4>
              {s.name} · {s.enabled ? "Enabled" : "Paused"}
            </h4>
            <p>
              <code>{s.cron}</code> · {s.timezone}
            </p>
            <p>
              {s.enabled
                ? `Next: ${new Date(s.next_run_at).toLocaleString()}`
                : "No new runs while paused"}
            </p>
            {s.last_run_at && (
              <p>Last occurrence: {new Date(s.last_run_at).toLocaleString()}</p>
            )}
            {s.last_error && <p role="status">{s.last_error}</p>}
            {canManage && (
              <div className="button-row">
                <Button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => load(s)}
                >
                  Edit schedule
                </Button>
                {s.enabled && (
                  <Button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await requestJson(
                          `/workflows/${workflowId}/schedules/${s.id}`,
                          "DELETE",
                          { revision: s.revision },
                        );
                        await list.refetch();
                        setNotice("Schedule paused. Existing runs continue.");
                      })
                    }
                  >
                    Pause
                  </Button>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
      {canManage && (
        <form
          className="configure-group"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await requestJson(
                `/workflows/${workflowId}/schedules${editing ? "/" + editing.id : ""}`,
                editing ? "PUT" : "POST",
                {
                  name,
                  versionId: version,
                  cron,
                  timezone: zone,
                  input: input || (fields.length ? "{}" : ""),
                  overlapPolicy: overlap,
                  missedPolicy: missed,
                  enabled,
                  ...(editing ? { revision: editing.revision } : {}),
                },
              );
              setEditing(null);
              await list.refetch();
              setNotice("Schedule saved.");
            });
          }}
        >
          <h4>{editing ? "Edit schedule" : "Add schedule"}</h4>
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={100}
            />
          </label>
          <label>
            Published version
            <select
              value={version}
              onChange={(e) => {
                setVersion(e.target.value);
                setInput("");
              }}
              required
            >
              <option value="">Select a published version</option>
              {versions.map((v) => (
                <option value={v.id} key={v.id}>
                  Version {v.version}
                </option>
              ))}
            </select>
          </label>
          <label>
            Frequency
            <select
              value={frequency}
              onChange={(e) => {
                setFrequency(e.target.value);
                setPreview([]);
              }}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="custom">Custom cron</option>
            </select>
          </label>
          {frequency === "custom" ? (
            <label>
              Five-field cron
              <input
                value={custom}
                onChange={(e) => {
                  setCustom(e.target.value);
                  setPreview([]);
                }}
                required
                placeholder="0 8 * * 1-5"
              />
            </label>
          ) : (
            <div className="form-grid">
              <label>
                Hour (0–23)
                <input
                  type="number"
                  min={0}
                  max={23}
                  required
                  value={hour}
                  onChange={(e) => {
                    setHour(e.target.value);
                    setPreview([]);
                  }}
                />
              </label>
              <label>
                Minute (0–59)
                <input
                  type="number"
                  min={0}
                  max={59}
                  required
                  value={minute}
                  onChange={(e) => {
                    setMinute(e.target.value);
                    setPreview([]);
                  }}
                />
              </label>
              {frequency === "weekly" && (
                <label>
                  Day
                  <select
                    value={weekday}
                    onChange={(e) => {
                      setWeekday(e.target.value);
                      setPreview([]);
                    }}
                  >
                    {[
                      "Sunday",
                      "Monday",
                      "Tuesday",
                      "Wednesday",
                      "Thursday",
                      "Friday",
                      "Saturday",
                    ].map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          <label>
            Timezone
            <input
              value={zone}
              onChange={(e) => {
                setZone(e.target.value);
                setPreview([]);
              }}
              required
              placeholder="Asia/Yangon"
            />
          </label>
          <Button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const result = await requestJson<{ times: string[] }>(
                  `/workflows/${workflowId}/schedules/preview`,
                  "POST",
                  { cron, timezone: zone },
                );
                setPreview(result.times);
              })
            }
          >
            Preview next runs
          </Button>
          {!!preview.length && (
            <ul>
              {preview.map((t) => (
                <li key={t}>
                  {new Date(t).toLocaleString(undefined, { timeZone: zone })} (
                  {zone})
                </li>
              ))}
            </ul>
          )}
          <WorkflowRunFields
            key={`${version}-${editing?.id ?? "new"}`}
            fields={fields}
            value={input}
            onChange={setInput}
          />
          <div className="setting-label-row">
            <label>
              When a previous run is active
              <select
                value={overlap}
                onChange={(e) => setOverlap(e.target.value)}
              >
                <option value="skip">Skip this occurrence</option>
                <option value="allow">Allow another run</option>
              </select>
            </label>
            <HelpTooltip>
              Active includes queued runs and runs waiting for human approval.
              Workspace concurrency limits still apply.
            </HelpTooltip>
          </div>
          <div className="setting-label-row">
            <label>
              After downtime
              <select
                value={missed}
                onChange={(e) => setMissed(e.target.value)}
              >
                <option value="skip">Skip missed occurrences</option>
                <option value="run_once">Run once on recovery</option>
              </select>
            </label>
            <HelpTooltip>
              Occurrences more than one minute late count as missed. Run once
              starts one catch-up run; it never replays the entire backlog.
            </HelpTooltip>
          </div>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Schedule enabled
          </label>
          <div className="button-row">
            <Button disabled={busy || !version}>
              {editing ? "Save schedule" : "Create schedule"}
            </Button>
            {editing && (
              <Button
                type="button"
                className="secondary"
                onClick={() => {
                  setEditing(null);
                  setInput("");
                }}
              >
                Cancel edit
              </Button>
            )}
          </div>
        </form>
      )}
      {!versions.length && (
        <p>Publish a valid workflow version before configuring triggers.</p>
      )}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
