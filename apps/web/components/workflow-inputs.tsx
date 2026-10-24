"use client";
import { useState } from "react";
import type { WorkflowGraph } from "@agentconnect/schemas/workflows";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";
type Field = WorkflowGraph["inputFields"][number];
export function WorkflowInputEditor({
  fields,
  onChange,
  disabled,
}: {
  fields: Field[];
  onChange: (fields: Field[]) => void;
  disabled: boolean;
}) {
  const update = (index: number, patch: Partial<Field>) =>
    onChange(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  return (
    <section className="configure-group">
      <div className="setting-label-row">
        <h4>Workflow inputs</h4>
        <HelpTooltip>
          Define named fields for manual tests, API requests and schedules. With
          no fields, the workflow keeps its existing text input. Save and
          publish to expose changes to integrations.
        </HelpTooltip>
      </div>
      {!fields.length && (
        <p className="muted">This workflow accepts text input.</p>
      )}
      {fields.map((f, i) => (
        <fieldset key={i} disabled={disabled} className="configure-group">
          <legend>Input {i + 1}</legend>
          <label>
            Field name
            <input
              value={f.name}
              maxLength={64}
              onChange={(e) => update(i, { name: e.target.value })}
            />
          </label>
          <label>
            Label
            <input
              value={f.label}
              maxLength={100}
              onChange={(e) => update(i, { label: e.target.value })}
            />
          </label>
          <label>
            Type
            <select
              value={f.type}
              onChange={(e) =>
                update(i, {
                  type: e.target.value as Field["type"],
                  defaultValue: undefined,
                })
              }
            >
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="boolean">Boolean</option>
              <option value="json">JSON data</option>
            </select>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={f.required}
              onChange={(e) => update(i, { required: e.target.checked })}
            />
            Required
          </label>
          <label>
            Default value (optional)
            <input
              key={f.type}
              defaultValue={
                f.defaultValue === undefined
                  ? ""
                  : f.type === "text"
                    ? String(f.defaultValue)
                    : JSON.stringify(f.defaultValue)
              }
              onBlur={(e) => {
                const raw = e.target.value;
                if (!raw) update(i, { defaultValue: undefined });
                else if (f.type === "text") update(i, { defaultValue: raw });
                else {
                  try {
                    update(i, { defaultValue: JSON.parse(raw) });
                    e.target.setCustomValidity("");
                  } catch {
                    e.target.setCustomValidity(
                      "Enter valid JSON, a number, true or false",
                    );
                    e.target.reportValidity();
                  }
                }
              }}
            />
          </label>
          <Button
            type="button"
            className="secondary"
            onClick={() => onChange(fields.filter((_, j) => j !== i))}
          >
            Remove input
          </Button>
        </fieldset>
      ))}
      <Button
        type="button"
        className="secondary"
        disabled={disabled || fields.length >= 30}
        onClick={() => {
          let n = fields.length + 1;
          while (fields.some((f) => f.name === `input_${n}`)) n++;
          onChange([
            ...fields,
            {
              name: `input_${n}`,
              label: `Input ${n}`,
              type: "text",
              required: false,
            },
          ]);
        }}
      >
        Add input field
      </Button>
    </section>
  );
}
export function WorkflowRunFields({
  fields,
  value,
  onChange,
  disabled = false,
}: {
  fields: Field[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [raw, setRaw] = useState<Record<string, string>>(() => {
    try {
      const v = JSON.parse(value || "{}");
      return Object.fromEntries(
        fields.map((f) => [
          f.name,
          v[f.name] === undefined
            ? f.defaultValue === undefined
              ? ""
              : f.type === "text"
                ? String(f.defaultValue)
                : JSON.stringify(f.defaultValue)
            : f.type === "text"
              ? String(v[f.name])
              : JSON.stringify(v[f.name]),
        ]),
      );
    } catch {
      return {};
    }
  });
  const [error, setError] = useState("");
  if (!fields.length)
    return (
      <label>
        Workflow input
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          maxLength={12000}
          required
          disabled={disabled}
        />
      </label>
    );
  function edit(name: string, value: string) {
    const next = { ...raw, [name]: value };
    setRaw(next);
    try {
      const result: Record<string, unknown> = {};
      for (const f of fields) {
        const text = next[f.name] ?? "";
        if (text === "") continue;
        result[f.name] = f.type === "text" ? text : JSON.parse(text);
      }
      onChange(JSON.stringify(result));
      setError("");
    } catch {
      onChange("!invalid");
      setError("Enter valid JSON for structured inputs.");
    }
  }
  return (
    <div className="workflow-typed-inputs">
      {fields.map((f) => (
        <label key={f.name}>
          {f.label}
          {f.required ? " *" : ""}
          {f.type === "boolean" ? (
            <select
              value={raw[f.name] ?? ""}
              disabled={disabled}
              onChange={(e) => edit(f.name, e.target.value)}
              required={f.required}
            >
              <option value="">Use default / omit</option>
              <option value="true">True</option>
              <option value="false">False</option>
            </select>
          ) : f.type === "json" ? (
            <textarea
              value={raw[f.name] ?? ""}
              disabled={disabled}
              onChange={(e) => edit(f.name, e.target.value)}
              required={f.required}
            />
          ) : (
            <input
              type={f.type === "number" ? "number" : "text"}
              step="any"
              value={raw[f.name] ?? ""}
              disabled={disabled}
              onChange={(e) => edit(f.name, e.target.value)}
              required={f.required}
              maxLength={12000}
            />
          )}
        </label>
      ))}
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </div>
  );
}
