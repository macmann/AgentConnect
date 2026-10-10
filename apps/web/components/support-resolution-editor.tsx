"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  resumeFacts,
  type ResumeFacts,
  type CopilotView,
} from "@agentconnect/schemas/support";
import { Button } from "./button";
import { requestJson } from "./agent-client";
export type ResolutionDraft = { facts: ResumeFacts | null; error: string };
export function SupportResolutionEditor({
  path,
  busy,
  onChange,
}: {
  path: string;
  busy: boolean;
  onChange: (v: ResolutionDraft) => void;
}) {
  const options = useQuery({
    queryKey: ["support-resolution-options", path],
    queryFn: () =>
      requestJson<{
        tools: { id: string; name: string }[];
        returnToAIEnabled: boolean;
        summaryEnabled: boolean;
      }>(path + "/resolution/options"),
    retry: false,
  });
  const [enabled, setEnabled] = useState(false),
    [values, setValues] = useState(resumeFacts.parse({})),
    [references, setReferences] = useState(""),
    [generated, setGenerated] = useState(false),
    [reviewed, setReviewed] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) {
      onChange({ facts: null, error: "" });
      return;
    }
    try {
      const refs: Record<string, string> = Object.create(null);
      for (const line of references
        .split("\n")
        .map((v) => v.trim())
        .filter(Boolean)) {
        const index = line.indexOf("="),
          key = line.slice(0, index).trim(),
          value = line.slice(index + 1).trim();
        if (index <= 0 || !key || !value || Object.hasOwn(refs, key))
          throw new Error("Enter each reference as a unique name=value pair.");
        refs[key] = value;
      }
      const parsed = resumeFacts.safeParse({
        ...values,
        actionsCompleted: values.actionsCompleted
          .map((v) => v.trim())
          .filter(Boolean),
        doNotRepeat: values.doNotRepeat.map((v) => v.trim()).filter(Boolean),
        references: refs,
      });
      if (!parsed.success)
        throw new Error(
          parsed.error.issues[0]?.message ?? "Check continuation fields",
        );
      if (!parsed.data.issue || !parsed.data.resolution)
        throw new Error(
          "Add an issue and approved resolution, or turn off sharing to use a generic fallback.",
        );
      if (generated && !reviewed)
        throw new Error(
          "Review the suggested facts and confirm your review before resolving.",
        );
      onChange({ facts: parsed.data, error: "" });
    } catch (e) {
      onChange({ facts: null, error: (e as Error).message });
    }
  }, [enabled, values, references, generated, reviewed, onChange]);
  async function suggest() {
    setLoading(true);
    setError("");
    try {
      const suggestion = await requestJson<CopilotView>(
        path + "/copilot",
        "POST",
        { kind: "resolution", regenerate: true },
      );
      if (suggestion.status !== "completed" || !suggestion.result?.resolution)
        throw new Error(
          suggestion.provenance.errorCode ??
            "Resolution suggestion unavailable",
        );
      setValues(resumeFacts.parse(suggestion.result.resolution));
      setReferences(
        Object.entries(suggestion.result.resolution.references)
          .map(([k, v]) => k + "=" + v)
          .join("\n"),
      );
      setEnabled(true);
      setGenerated(true);
      setReviewed(false);
    } catch (e) {
      setError(
        (e as Error).message +
          ". You can still resolve using your own fields or the deterministic fallback.",
      );
    } finally {
      setLoading(false);
    }
  }
  function update<K extends keyof ResumeFacts>(key: K, value: ResumeFacts[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    if (generated) setReviewed(false);
  }
  return (
    <section
      className="support-resolution-editor"
      aria-label="AI continuation context"
    >
      <h4>AI continuation context</h4>
      <p>
        Only the approved facts below and permitted customer-visible messages
        reach the AI. Your private resolution summary and internal notes stay
        private.
      </p>
      {options.data?.returnToAIEnabled === false && (
        <p role="status">
          Return to AI is disabled by policy. The case will resolve with AI chat
          paused until an authorized operator resumes it.
        </p>
      )}
      <label className="support-resolution-toggle">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || loading}
          onChange={(e) => setEnabled(e.target.checked)}
        />{" "}
        Share approved resolution facts with the AI
      </label>
      {enabled && (
        <fieldset
          disabled={busy || loading}
          className="support-resolution-fields"
        >
          <label>
            Issue for AI
            <input
              value={values.issue}
              maxLength={500}
              onChange={(e) => update("issue", e.target.value)}
            />
          </label>
          <label>
            Approved resolution for AI
            <textarea
              rows={3}
              value={values.resolution}
              maxLength={2000}
              onChange={(e) => update("resolution", e.target.value)}
            />
          </label>
          <label>
            Completed actions (one per line)
            <textarea
              rows={3}
              value={values.actionsCompleted.join("\n")}
              maxLength={6500}
              onChange={(e) =>
                update("actionsCompleted", e.target.value.split("\n"))
              }
            />
          </label>
          <label>
            Reference IDs (one name=value per line)
            <textarea
              rows={2}
              value={references}
              maxLength={4800}
              placeholder="disputeId=DSP-29219"
              onChange={(e) => {
                setReferences(e.target.value);
                if (generated) setReviewed(false);
              }}
            />
          </label>
          <label>
            Expected next step
            <textarea
              rows={2}
              value={values.expectedNextStep}
              maxLength={1000}
              onChange={(e) => update("expectedNextStep", e.target.value)}
            />
          </label>
          <label>
            Do not repeat (one action per line)
            <textarea
              rows={2}
              value={values.doNotRepeat.join("\n")}
              maxLength={6500}
              onChange={(e) =>
                update("doNotRepeat", e.target.value.split("\n"))
              }
            />
          </label>
          {!!options.data?.tools.length && (
            <div>
              <h5>Tools the AI must not run again</h5>
              {options.data.tools.map((t) => (
                <label key={t.id} className="support-resolution-toggle">
                  <input
                    type="checkbox"
                    checked={values.doNotRepeatToolIds.includes(t.id)}
                    onChange={(e) =>
                      update(
                        "doNotRepeatToolIds",
                        e.target.checked
                          ? [...values.doNotRepeatToolIds, t.id]
                          : values.doNotRepeatToolIds.filter(
                              (id) => id !== t.id,
                            ),
                      )
                    }
                  />
                  {t.name}
                </label>
              ))}
            </div>
          )}
          {generated && (
            <label className="support-resolution-toggle">
              <input
                type="checkbox"
                checked={reviewed}
                onChange={(e) => setReviewed(e.target.checked)}
              />{" "}
              I reviewed these AI-suggested details against the conversation
            </label>
          )}
        </fieldset>
      )}
      {!enabled && (
        <small>
          A deterministic fallback will record the customer-visible final reply,
          if provided, or a generic resolution. It will not infer completed
          actions from your private notes.
        </small>
      )}
      {options.data?.summaryEnabled && (
        <Button
          type="button"
          className="secondary"
          disabled={busy || loading}
          onClick={() => {
            if (
              enabled &&
              !window.confirm(
                "Replace the current continuation facts with an AI suggestion for review?",
              )
            )
              return;
            void suggest();
          }}
        >
          {loading ? "Preparing suggestion…" : "Suggest resolution facts"}
        </Button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {options.error && (
        <p className="muted">
          Continuation options are unavailable. You can still enter facts or
          resolve with the deterministic fallback.
        </p>
      )}
    </section>
  );
}
