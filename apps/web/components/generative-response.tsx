"use client";
import { useState, type FormEvent } from "react";
import type { RenderedBlock } from "@agentconnect/schemas/generative";
import { Button } from "./button";
import { apiBase } from "./agent-client";
async function actionRequest(path: string, body: unknown, guestToken?: string) {
  const response = await fetch(apiBase + path, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(guestToken ? { Authorization: `Bearer ${guestToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Action failed");
  return result;
}
export function GenerativeResponse({
  blocks,
  messageId,
  guestToken,
  interactive = true,
}: {
  blocks: RenderedBlock[];
  messageId: string;
  guestToken?: string;
  interactive?: boolean;
}) {
  return (
    <div className="generative-blocks">
      {blocks
        .filter((b) => b.type !== "text")
        .map((block, index) => {
          if (block.type === "chart")
            return <Chart key={index} block={block} />;
          if (block.type === "table")
            return (
              <section className="generated-block" key={index}>
                <h4>{block.title}</h4>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        {block.columns.map((c) => (
                          <th key={c.key}>{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {block.rows.map((row, i) => (
                        <tr key={i}>
                          {block.columns.map((c) => (
                            <td key={c.key}>{String(row[c.key] ?? "")}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            );
          if (block.type === "form" || block.type === "action")
            return (
              <ActionBlock
                key={`${messageId}-${block.id}`}
                block={block}
                messageId={messageId}
                guestToken={guestToken}
                interactive={interactive}
              />
            );
          if (block.type === "file")
            return (
              <FileBlock key={index} block={block} guestToken={guestToken} />
            );
          if (block.type === "kpi")
            return (
              <section className="generated-block generated-kpi" key={index}>
                <h4>{block.title}</h4>
                <strong>{block.value}</strong>
              </section>
            );
          if (block.type === "card" || block.type === "alert")
            return (
              <section
                className={`generated-block ${block.type === "alert" ? `generated-alert ${block.severity}` : ""}`}
                key={index}
              >
                <h4>{block.title}</h4>
                <p>{block.content}</p>
              </section>
            );
          return null;
        })}
    </div>
  );
}
function Chart({
  block,
}: {
  block: Extract<RenderedBlock, { type: "chart" }>;
}) {
  const max = Math.max(1, ...block.data.map((d) => d.value)),
    sum = block.data.reduce((s, d) => s + d.value, 0) || 1,
    colors = ["#256c55", "#6a9e7e", "#b3caaa", "#d6ad58", "#9c7fba", "#6e9cad"];
  const points = block.data
    .map(
      (d, i) =>
        `${35 + (i * 330) / Math.max(1, block.data.length - 1)},${180 - (d.value / max) * 150}`,
    )
    .join(" ");
  let offset = 0;
  return (
    <section className="generated-block">
      <h4>{block.title}</h4>
      <svg
        viewBox="0 0 400 220"
        role="img"
        aria-label={`${block.title}, ${block.chartType} chart`}
        className="generated-chart"
      >
        {block.chartType === "pie" || block.chartType === "donut" ? (
          <>
            {block.data.map((d, i) => {
              const circumference = 2 * Math.PI * 70,
                length = (d.value / sum) * circumference,
                previous = offset;
              offset += length;
              if (block.chartType === "pie") {
                const start = previous / 70 - Math.PI / 2,
                  end = offset / 70 - Math.PI / 2,
                  label = (
                    <title>
                      {d.label}: {d.value}
                    </title>
                  );
                if (d.value === 0) return null;
                if (d.value === sum)
                  return (
                    <circle
                      key={i}
                      cx={200}
                      cy={110}
                      r={70}
                      fill={colors[i % colors.length]}
                    >
                      {label}
                    </circle>
                  );
                return (
                  <path
                    key={i}
                    fill={colors[i % colors.length]}
                    d={`M 200 110 L ${200 + 70 * Math.cos(start)} ${110 + 70 * Math.sin(start)} A 70 70 0 ${d.value / sum > 0.5 ? 1 : 0} 1 ${200 + 70 * Math.cos(end)} ${110 + 70 * Math.sin(end)} Z`}
                  >
                    {label}
                  </path>
                );
              }
              return (
                <circle
                  key={i}
                  cx={200}
                  cy={110}
                  r={70}
                  fill="none"
                  stroke={colors[i % colors.length]}
                  strokeWidth={28}
                  strokeDasharray={`${length} ${circumference - length}`}
                  strokeDashoffset={-previous}
                  transform="rotate(-90 200 110)"
                >
                  <title>
                    {d.label}: {d.value}
                  </title>
                </circle>
              );
            })}
          </>
        ) : (
          <>
            <line x1={25} y1={180} x2={385} y2={180} stroke="#b3caaa" />
            {block.chartType === "bar" ? (
              block.data.map((d, i) => (
                <rect
                  key={i}
                  x={30 + (i * 350) / block.data.length}
                  y={180 - (d.value / max) * 150}
                  width={Math.max(2, 300 / block.data.length)}
                  height={(d.value / max) * 150}
                  fill={colors[0]}
                >
                  <title>
                    {d.label}: {d.value}
                  </title>
                </rect>
              ))
            ) : (
              <>
                {block.chartType === "area" && (
                  <polygon points={`35,180 ${points} 365,180`} fill="#e2eee5" />
                )}
                {block.chartType !== "scatter" && (
                  <polyline
                    points={points}
                    fill="none"
                    stroke={colors[0]}
                    strokeWidth={3}
                  />
                )}
                {block.data.map((d, i) => (
                  <circle
                    key={i}
                    cx={35 + (i * 330) / Math.max(1, block.data.length - 1)}
                    cy={180 - (d.value / max) * 150}
                    r={4}
                    fill={colors[0]}
                  >
                    <title>
                      {d.label}: {d.value}
                    </title>
                  </circle>
                ))}
              </>
            )}
            <text x={25} y={15} fontSize={11} fill="#57635c">
              {max.toLocaleString()}
            </text>
            <text x={30} y={205} fontSize={11} fill="#57635c">
              {block.data[0]?.label}
            </text>
            <text x={380} y={205} textAnchor="end" fontSize={11} fill="#57635c">
              {block.data.at(-1)?.label}
            </text>
          </>
        )}
      </svg>
      <details>
        <summary>View chart data</summary>
        <table>
          <thead>
            <tr>
              <th>Label</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            {block.data.map((d, i) => (
              <tr key={i}>
                <td>{d.label}</td>
                <td>{d.value.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
function ActionBlock({
  block,
  messageId,
  guestToken,
  interactive,
}: {
  block: Extract<RenderedBlock, { type: "form" | "action" }>;
  messageId: string;
  guestToken?: string;
  interactive: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [done, setDone] = useState(false),
    [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (
      !window.confirm(
        "Submit these values to this workspace? This stores a record linked to your conversation.",
      )
    )
      return;
    const form = new FormData(e.currentTarget),
      values: Record<string, unknown> = {};
    if (block.type === "form")
      for (const f of block.fields) {
        const v = form.get(f.name);
        if (f.type === "checkbox") values[f.name] = v === "on";
        else if (f.type === "number") {
          if (v !== null && v !== "") values[f.name] = Number(v);
        } else if (v !== null && v !== "") values[f.name] = v;
      }
    setBusy(true);
    setError("");
    try {
      await actionRequest(
        `/messages/${messageId}/actions/${block.id}`,
        { confirmed: true, values },
        guestToken,
      );
      setDone(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="generated-block">
      <h4>{block.title}</h4>
      {done ? (
        <p role="status">Submitted. Your values were saved.</p>
      ) : !interactive ? (
        <p className="muted">Submissions are disabled in this view.</p>
      ) : (
        <form className="generated-form" onSubmit={submit}>
          {block.type === "form" &&
            block.fields.map((f) => (
              <label
                key={f.name}
                className={f.type === "checkbox" ? "generated-checkbox" : ""}
              >
                {f.type === "checkbox" ? (
                  <>
                    <input
                      name={f.name}
                      type="checkbox"
                      required={f.required}
                    />
                    {f.label}
                  </>
                ) : (
                  <>
                    {f.label}
                    {f.type === "select" ? (
                      <select name={f.name} required={f.required}>
                        <option value="">Choose an option</option>
                        {f.options?.map((option, i) => (
                          <option key={i}>{option}</option>
                        ))}
                      </select>
                    ) : f.type === "textarea" ? (
                      <textarea
                        name={f.name}
                        required={f.required}
                        maxLength={4000}
                      />
                    ) : (
                      <input
                        name={f.name}
                        type={f.type}
                        required={f.required}
                        min={f.min}
                        max={f.max}
                        maxLength={4000}
                      />
                    )}
                  </>
                )}
              </label>
            ))}
          <p className="muted">
            Submitting stores these values in this workspace. Confirm before
            continuing.
          </p>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <Button disabled={busy}>
            {busy
              ? "Submitting…"
              : block.type === "form"
                ? block.submitLabel
                : block.label}
          </Button>
        </form>
      )}
    </section>
  );
}
function FileBlock({
  block,
  guestToken,
}: {
  block: Extract<RenderedBlock, { type: "file" }>;
  guestToken?: string;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function download() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
          `${apiBase}/artifacts/${block.artifactId}/grant`,
          {
            credentials: "include",
            headers: guestToken
              ? { Authorization: `Bearer ${guestToken}` }
              : {},
          },
        ),
        result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Download unavailable");
      const link = document.createElement("a");
      link.href = apiBase + result.path;
      link.rel = "noreferrer";
      link.click();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="generated-block generated-file">
      <div>
        <h4>{block.title}</h4>
        <small>{block.format.toUpperCase()} file</small>
      </div>
      <Button
        type="button"
        className="secondary"
        disabled={busy || !block.artifactId}
        onClick={() => {
          void download();
        }}
      >
        {!block.artifactId
          ? "File expired"
          : busy
            ? "Preparing…"
            : "Download file"}
      </Button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
