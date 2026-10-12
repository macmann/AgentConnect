"use client";
import { HelpTooltip } from "./help-tooltip";
import { modelRouting } from "@agentconnect/schemas/model-routing";
import type { Draft, Model } from "./agent-studio";
import type { ConfigureIssue } from "./agent-configure-state";
import {
  ConfigureField as Field,
  ConfigureGroup as Group,
} from "./agent-configure-fields";

export function ModelRoutingControls({
  draft,
  models,
  update,
  issues,
}: {
  draft: Draft;
  models: Model[];
  update: (value: Draft) => void;
  issues: ConfigureIssue[];
}) {
  const value = { ...modelRouting.parse({}), ...draft.config.modelRouting };
  const change = (patch: Partial<typeof value>) =>
    update({
      ...draft,
      config: { ...draft.config, modelRouting: { ...value, ...patch } },
    });
  const choices = models.filter((m) => m.id !== draft.config.modelId);
  function modelSelect(
    attributes: {
      id: string;
      "aria-invalid": boolean;
      "aria-describedby": string | undefined;
    },
    selected: string | null,
    onChange: (id: string) => void,
  ) {
    return (
      <select
        {...attributes}
        value={selected ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">None</option>
        {selected && !choices.some((m) => m.id === selected) && (
          <option value={selected}>Unavailable model</option>
        )}
        {choices.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name} · {m.provider}
          </option>
        ))}
      </select>
    );
  }
  return (
    <Group title="Model routing and failover">
      <p className="muted">
        The primary model handles normal queries. Route explicitly approved
        short queries to a lighter model. Published versions keep a snapshot of
        every selected model.
      </p>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(e) => change({ enabled: e.target.checked })}
        />
        Route matching queries to a lighter model
      </label>
      {value.enabled && (
        <>
          <Field
            field="config.modelRouting.lightModelId"
            label="Lighter model"
            issues={issues}
          >
            {(a) => (
              <div>
                {modelSelect(a, value.lightModelId, (id) =>
                  change({ lightModelId: id || null }),
                )}
              </div>
            )}
          </Field>
          <Field
            field="config.modelRouting.phrases"
            label="Approved query phrases"
            issues={issues}
            help="Exact matching ignores capitalization and repeated spaces. One query per line; short length alone never triggers routing."
          >
            {(a) => (
              <textarea
                {...a}
                rows={4}
                value={value.phrases.join("\n")}
                onChange={(e) =>
                  change({ phrases: e.target.value.split("\n") })
                }
                onBlur={() =>
                  change({
                    phrases: value.phrases.map((p) => p.trim()).filter(Boolean),
                  })
                }
                placeholder={"Hello\nWhat are your opening hours?"}
              />
            )}
          </Field>
          <Field
            field="config.modelRouting.maxQueryCharacters"
            label="Maximum routed query length"
            issues={issues}
          >
            {(a) => (
              <input
                {...a}
                type="number"
                min={10}
                max={2000}
                value={value.maxQueryCharacters}
                onChange={(e) =>
                  change({ maxQueryCharacters: Number(e.target.value) })
                }
              />
            )}
          </Field>
          <div className="setting-label-row">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={value.firstTurnOnly}
                onChange={(e) => change({ firstTurnOnly: e.target.checked })}
              />
              Only route the first turn of a conversation
            </label>
            <HelpTooltip>
              If a routed request does not fit the lighter model, use the
              primary model. A transient lighter-model failure may also fall
              back to the primary model before response text starts.
            </HelpTooltip>
          </div>
        </>
      )}
      <details className="configure-details">
        <summary>Controlled provider fallback</summary>
        <div className="setting-label-row">
          <span>
            Try these models in order on network errors, first-token timeouts or
            provider HTTP 5xx errors.
          </span>
          <HelpTooltip>
            Authentication, invalid parameters, safety blocks and failures after
            response text starts never trigger fallback. Knowledge and tools are
            not re-executed.
          </HelpTooltip>
        </div>
        {[0, 1].map((index) => (
          <Field
            key={index}
            field={`config.modelRouting.fallbackModelIds.${index}`}
            label={`Fallback model ${index + 1}`}
            issues={issues}
          >
            {(a) => (
              <div>
                {modelSelect(a, value.fallbackModelIds[index] ?? null, (id) => {
                  const ids = [...value.fallbackModelIds];
                  ids[index] = id;
                  change({ fallbackModelIds: ids.filter(Boolean) });
                })}
              </div>
            )}
          </Field>
        ))}
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={value.fallbackOnRateLimit}
            onChange={(e) => change({ fallbackOnRateLimit: e.target.checked })}
          />
          Also allow fallback on rate limits
        </label>
        <Field
          field="config.modelRouting.firstTokenTimeoutMs"
          label="First-token timeout (milliseconds)"
          issues={issues}
          help="Applies when routing or fallback is configured. The overall chat deadline still applies."
        >
          {(a) => (
            <input
              {...a}
              type="number"
              min={1000}
              max={30000}
              step={1000}
              value={value.firstTokenTimeoutMs}
              onChange={(e) =>
                change({ firstTokenTimeoutMs: Number(e.target.value) })
              }
            />
          )}
        </Field>
      </details>
    </Group>
  );
}
