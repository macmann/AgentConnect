"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { example } from "@agentconnect/schemas/quality";
import { scripts } from "@agentconnect/schemas/multilingual";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";
type Variant = {
  key: string;
  language: string;
  answerLanguage: string;
  question: string;
  required: string;
  script: string;
};
const variant = (language: string): Variant => ({
  key: globalThis.crypto.randomUUID(),
  language,
  answerLanguage: language,
  question: "",
  required: "",
  script: "",
});
export function MultilingualBenchmarkBuilder({
  workspaceId,
  onAdd,
}: {
  workspaceId: string;
  onAdd: (cases: unknown[]) => void;
}) {
  const [intent, setIntent] = useState(""),
    [sourceLanguage, setSourceLanguage] = useState("en"),
    [kb, setKb] = useState(""),
    [source, setSource] = useState(""),
    [variants, setVariants] = useState(() => [variant("en"), variant("th")]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const bases = useQuery({
    queryKey: ["benchmark-bases", workspaceId],
    queryFn: () =>
      requestJson<{ id: string; name: string }[]>(
        `/workspaces/${workspaceId}/knowledge-bases`,
      ),
  });
  const sources = useQuery({
    queryKey: ["benchmark-sources", kb],
    queryFn: () =>
      requestJson<{ id: string; title: string; status: string }[]>(
        `/knowledge-bases/${kb}/sources`,
      ),
    enabled: !!kb,
  });
  const update = (key: string, patch: Partial<Variant>) =>
    setVariants((current) =>
      current.map((v) => (v.key === key ? { ...v, ...patch } : v)),
    );
  return (
    <details className="configure-group">
      <summary>Add multilingual retrieval cases</summary>
      <p>
        Compare the same intent across languages using questions and answer
        checks you have reviewed.{" "}
        <HelpTooltip>
          Language tags and source language are reviewer annotations. Expected
          sources measure retrieval; required phrases check the answer. Optional
          script coverage measures writing systems, not language identity.
          Select an LLM judge to assess language compliance, especially
          languages sharing a script. No translations or ground truth are
          generated automatically.
        </HelpTooltip>
      </p>
      {(error || bases.error || sources.error) && (
        <p role="alert">
          {error || bases.error?.message || sources.error?.message}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="form-grid">
        <label>
          Shared intent
          <input
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            maxLength={100}
            placeholder="Password reset"
          />
        </label>
        <label>
          Source language tag
          <input
            value={sourceLanguage}
            onChange={(e) => setSourceLanguage(e.target.value)}
            placeholder="en"
            maxLength={40}
          />
        </label>
        <label>
          Multilingual knowledge base
          <select
            aria-label="Multilingual knowledge base"
            value={kb}
            onChange={(e) => {
              setKb(e.target.value);
              setSource("");
            }}
          >
            <option value="">Choose knowledge</option>
            {bases.data?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Expected retrieved source
          <select
            aria-label="Expected retrieved source"
            value={source}
            onChange={(e) => setSource(e.target.value)}
          >
            <option value="">Choose a ready source</option>
            {sources.data
              ?.filter((s) => s.status === "ready")
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
          </select>
        </label>
      </div>
      {variants.map((v, i) => (
        <fieldset key={v.key} className="multilingual-variant">
          <legend>Language variant {i + 1}</legend>
          <div className="form-grid">
            <label>
              Question language
              <input
                aria-label={`Variant ${i + 1} question language`}
                value={v.language}
                onChange={(e) => update(v.key, { language: e.target.value })}
              />
            </label>
            <label>
              Answer language
              <input
                aria-label={`Variant ${i + 1} answer language`}
                value={v.answerLanguage}
                onChange={(e) =>
                  update(v.key, { answerLanguage: e.target.value })
                }
              />
            </label>
          </div>
          <label>
            Question
            <textarea
              aria-label={`Variant ${i + 1} question`}
              value={v.question}
              onChange={(e) => update(v.key, { question: e.target.value })}
              maxLength={12000}
            />
          </label>
          <label>
            Required answer phrase
            <input
              aria-label={`Variant ${i + 1} required phrase`}
              value={v.required}
              onChange={(e) => update(v.key, { required: e.target.value })}
              maxLength={500}
            />
          </label>
          <label>
            Optional script check
            <select
              aria-label={`Variant ${i + 1} script`}
              value={v.script}
              onChange={(e) => update(v.key, { script: e.target.value })}
            >
              <option value="">No script check</option>
              {scripts.map((script) => (
                <option key={script}>{script}</option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            className="secondary"
            disabled={variants.length <= 2}
            onClick={() =>
              setVariants(variants.filter((row) => row.key !== v.key))
            }
          >
            Remove variant {i + 1}
          </Button>
        </fieldset>
      ))}
      <div className="studio-actions">
        <Button
          type="button"
          className="secondary"
          disabled={variants.length >= 10}
          onClick={() => setVariants([...variants, variant("en")])}
        >
          Add language variant
        </Button>
        <Button
          type="button"
          onClick={() => {
            setError("");
            setNotice("");
            try {
              if (!intent.trim())
                throw new Error(
                  "Enter a shared intent for these language cases",
                );
              if (!source) throw new Error("Choose a ready expected source");
              if (variants.some((v) => !v.question.trim()))
                throw new Error("Add a question for every language variant");
              if (variants.some((v) => !v.required.trim()))
                throw new Error(
                  "Add a reviewed answer phrase for every language variant",
                );
              const cases = variants.map((v, index) => {
                const parsed = example.safeParse({
                  input: v.question,
                  expectedBehavior: `Answer the ${intent} question in ${v.answerLanguage}, using the expected knowledge and citations.`,
                  contains: [v.required.trim()],
                  expectedSourceIds: [source],
                  multilingual: {
                    intent,
                    queryLanguage: v.language,
                    sourceLanguage,
                    expectedAnswerLanguage: v.answerLanguage,
                    expectedScripts: v.script ? [v.script] : [],
                  },
                });
                if (!parsed.success)
                  throw new Error(
                    `Variant ${index + 1}: ${parsed.error.issues[0]?.message ?? "Check the language fields"}`,
                  );
                return parsed.data;
              });
              onAdd(cases);
              setNotice(
                `${cases.length} language cases added. Save the dataset before evaluating.`,
              );
            } catch (cause) {
              setError(
                cause instanceof Error ? cause.message : "Unable to add cases",
              );
            }
          }}
        >
          Add language cases to dataset
        </Button>
      </div>
    </details>
  );
}
