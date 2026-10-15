import { HelpTooltip } from "./help-tooltip";
export type LanguageResult = {
  label: string;
  cases: number;
  failedCases: number;
  passRate: number;
  retrievalRecall: number | null;
  citationRecall: number | null;
  scriptPassRate: number | null;
  languageCompliance: number | null;
  latencyMs: number | null;
};
export type MultilingualResults = {
  languagePairs: LanguageResult[];
  intents: LanguageResult[];
};
export function MultilingualReport({
  report,
  baseline,
}: {
  report?: MultilingualResults;
  baseline?: {
    label: string;
    passRateDelta: number;
    retrievalRecallDelta: number | null;
    citationRecallDelta: number | null;
    languageComplianceDelta: number | null;
  }[];
}) {
  if (!report?.languagePairs.length) return null;
  const percent = (v: number | null) =>
    v === null ? "Not measured" : `${(v * 100).toFixed(1)}%`;
  return (
    <section className="benchmark-summary multilingual-report">
      <h4>Multilingual retrieval validation</h4>
      <p>
        Language pairs are question → source / expected answer.{" "}
        <HelpTooltip>
          Script checks do not identify languages sharing a writing system.
          Language compliance is measured only by an LLM judge and remains an
          estimate. Retrieval and cited-source recall use the expected sources
          you authored. Failed executions remain in case/pass counts;
          unavailable measurements are excluded from metric averages.
        </HelpTooltip>
      </p>
      {(
        [
          ["By language pair", report.languagePairs],
          ["By shared intent", report.intents],
        ] as const
      ).map(([title, rows]) => (
        <div
          className="table-wrap"
          key={title}
          tabIndex={0}
          role="region"
          aria-label={title}
        >
          <table>
            <caption>{title}</caption>
            <thead>
              <tr>
                <th>Group</th>
                <th>Cases / failures</th>
                <th>Pass rate</th>
                <th>Retrieval</th>
                <th>Cited sources</th>
                <th>Script checks</th>
                <th>Judge language</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td>
                    {row.cases} / {row.failedCases}
                  </td>
                  <td>{percent(row.passRate)}</td>
                  <td>{percent(row.retrievalRecall)}</td>
                  <td>{percent(row.citationRecall)}</td>
                  <td>{percent(row.scriptPassRate)}</td>
                  <td>{percent(row.languageCompliance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {!!baseline?.length && (
        <details>
          <summary>Language-pair changes from baseline</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Language pair</th>
                  <th>Pass rate change</th>
                  <th>Retrieval change</th>
                  <th>Citation change</th>
                  <th>Judge language change</th>
                </tr>
              </thead>
              <tbody>
                {baseline.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    {[
                      row.passRateDelta,
                      row.retrievalRecallDelta,
                      row.citationRecallDelta,
                      row.languageComplianceDelta,
                    ].map((value, i) => (
                      <td key={i}>
                        {value === null
                          ? "Not measured"
                          : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pp`}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
