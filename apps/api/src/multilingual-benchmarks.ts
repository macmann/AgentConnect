import type { Example } from "@agentconnect/schemas/quality";
/** Script coverage is an explicit authored check, never a claim of language detection. */
export function scoreMultilingual(
  example: Example,
  output: string,
  citations: { sourceId: string }[],
) {
  const config = example.multilingual;
  if (!config) return null;
  const letters = Array.from(output.normalize("NFC")).filter((c) =>
    /\p{L}/u.test(c),
  );
  const patterns = config.expectedScripts.map(
    (script) => new RegExp(`\\p{Script_Extensions=${script}}`, "u"),
  );
  const matching = letters.filter((c) =>
    patterns.some((pattern) => pattern.test(c)),
  ).length;
  const scriptRatio = patterns.length
    ? letters.length
      ? matching / letters.length
      : 0
    : null;
  const citationRecall =
    example.expectedSourceIds.filter((id) =>
      citations.some((c) => c.sourceId === id),
    ).length / example.expectedSourceIds.length;
  return {
    ...config,
    crossLanguage:
      new Intl.Locale(config.queryLanguage).language !==
      new Intl.Locale(config.sourceLanguage).language,
    citationPassed: !config.requireSourceCitations || citationRecall === 1,
    scriptRatio,
    scriptPassed:
      scriptRatio === null ? null : scriptRatio >= config.minScriptRatio,
    citationRecall,
    languageAssessment:
      "Script coverage does not establish language identity; see judge.languageCompliance when measured.",
  };
}
export function multilingualSummary(
  examples: Example[],
  results: {
    example_id: string;
    passed: boolean;
    status: string;
    metrics: Record<string, unknown>;
  }[],
) {
  const annotated = examples.filter((e) => e.multilingual);
  const group = (key: (e: Example) => string) => {
    const keys = [...new Set(annotated.map(key))];
    return keys.map((label) => {
      const cases = annotated.filter((e) => key(e) === label),
        rows = results.filter((r) => cases.some((e) => e.id === r.example_id));
      const mean = (getter: (r: (typeof rows)[number]) => unknown) => {
        const values = rows
          .map(getter)
          .filter(
            (v): v is number => typeof v === "number" && Number.isFinite(v),
          );
        return values.length
          ? values.reduce((a, b) => a + b, 0) / values.length
          : null;
      };
      return {
        label,
        cases: rows.length,
        failedCases: rows.filter((r) => r.status === "failed").length,
        passRate: rows.length
          ? rows.filter((r) => r.passed).length / rows.length
          : 0,
        retrievalRecall: mean((r) => r.metrics.retrievalRecall),
        citationRecall: mean(
          (r) =>
            (r.metrics.multilingual as { citationRecall?: number } | undefined)
              ?.citationRecall,
        ),
        scriptPassRate: mean((r) => {
          const value = (
            r.metrics.multilingual as
              { scriptPassed?: boolean | null } | undefined
          )?.scriptPassed;
          return typeof value === "boolean" ? Number(value) : null;
        }),
        languageCompliance: mean(
          (r) =>
            (r.metrics.judge as { languageCompliance?: number } | undefined)
              ?.languageCompliance,
        ),
        latencyMs: mean((r) => r.metrics.latencyMs),
      };
    });
  };
  return {
    languagePairs: group(
      (e) =>
        `${new Intl.Locale(e.multilingual!.queryLanguage).baseName} → ${new Intl.Locale(e.multilingual!.sourceLanguage).baseName} / answer ${new Intl.Locale(e.multilingual!.expectedAnswerLanguage).baseName}`,
    ),
    intents: group((e) => e.multilingual!.intent),
  };
}

export type LanguageReport = ReturnType<typeof multilingualSummary>;
export function compareLanguagePairs(
  current: LanguageReport,
  baseline?: LanguageReport,
) {
  return current.languagePairs.flatMap((row) => {
    const before = baseline?.languagePairs.find(
      (old) => old.label === row.label,
    );
    if (!before) return [];
    const delta = (a: number | null, b: number | null) =>
      a === null || b === null ? null : a - b;
    return [
      {
        label: row.label,
        passRateDelta: row.passRate - before.passRate,
        retrievalRecallDelta: delta(
          row.retrievalRecall,
          before.retrievalRecall,
        ),
        citationRecallDelta: delta(row.citationRecall, before.citationRecall),
        languageComplianceDelta: delta(
          row.languageCompliance,
          before.languageCompliance,
        ),
      },
    ];
  });
}
