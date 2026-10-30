"use client";
import { useQuery } from "@tanstack/react-query";
import { ConfigureField } from "./agent-configure-fields";
import { agentSkills } from "@agentconnect/schemas/agent-skills";
import type { SectionProps } from "./agent-configure-sections";
import type { SkillSummary } from "./skills-studio";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import { HelpTooltip } from "./help-tooltip";
export function AgentSkillsSection(p: SectionProps) {
  const settings = p.draft.config.skills ?? agentSkills.parse({});
  const skills = useQuery({
    queryKey: ["agent-skills", p.workspaceId],
    queryFn: () =>
      requestJson<SkillSummary[]>(`/workspaces/${p.workspaceId}/agent-skills`),
  });
  const update = (value: Partial<typeof settings>) =>
    p.update({
      ...p.draft,
      config: { ...p.draft.config, skills: { ...settings, ...value } },
    });
  const known = new Set(
    skills.data?.flatMap((s) => s.versions.map((v) => v.id)),
  );
  const unavailable = settings.versionIds.filter((id) => !known.has(id));
  return (
    <section className="agent-skill-picker">
      <div className="skill-detail-heading">
        <h4>Attached skills</h4>
        <Button
          className="secondary"
          type="button"
          onClick={() => p.manage("Skills")}
        >
          Manage skills
        </Button>
      </div>
      <p className="muted">
        Skills add reusable procedures. Knowledge supplies evidence; tools
        access external information.
      </p>
      {skills.isPending ? (
        <p role="status">Loading skills…</p>
      ) : skills.error ? (
        <p role="alert" className="error-banner">
          Could not load skills.{" "}
          <Button
            type="button"
            className="secondary"
            onClick={() => void skills.refetch()}
          >
            Retry
          </Button>
        </p>
      ) : (
        <>
          {!skills.data?.length && (
            <div className="empty">
              <h4>No skills available</h4>
              <p>
                Upload SKILL.md or a skill ZIP to your workspace, then attach a
                version here.
              </p>
              <Button type="button" onClick={() => p.manage("Skills")}>
                Upload a skill
              </Button>
            </div>
          )}
          {skills.data?.map((skill) => {
            const attached = skill.versions.find((v) =>
              settings.versionIds.includes(v.id),
            );
            return (
              <div className="skill-attachment" key={skill.id}>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={!!attached}
                    disabled={
                      !attached &&
                      (!skill.enabled || settings.versionIds.length >= 5)
                    }
                    onChange={(e) =>
                      update({
                        versionIds: e.target.checked
                          ? [...settings.versionIds, skill.version_id]
                          : settings.versionIds.filter(
                              (id) => !skill.versions.some((v) => v.id === id),
                            ),
                      })
                    }
                  />
                  {skill.name}
                </label>
                <span className="muted">
                  {skill.enabled ? "Enabled" : "Disabled"} ·{" "}
                  {skill.public_access
                    ? "Public chat approved"
                    : "Workspace only"}
                </span>
                <p>{skill.description}</p>
                {attached && (
                  <label>
                    Version
                    <select
                      aria-label={`${skill.name} skill version`}
                      value={attached.id}
                      onChange={(e) =>
                        update({
                          versionIds: settings.versionIds.map((id) =>
                            id === attached.id ? e.target.value : id,
                          ),
                        })
                      }
                    >
                      {skill.versions.map((v) => (
                        <option value={v.id} key={v.id}>
                          Version {v.version}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {!!skill.warnings?.length && (
                  <small>
                    Contains unsupported files or compatibility notes. Review in
                    Skills before use.
                  </small>
                )}
                {!!attached && !skill.enabled && (
                  <p role="alert">
                    This skill is disabled. Remove it or enable it before
                    publishing.
                  </p>
                )}
              </div>
            );
          })}
          {!!unavailable.length && (
            <div role="alert">
              <p>
                Some pinned versions are not in the recent skill catalog. They
                may be archived or unavailable. Saving rechecks access.
              </p>
              {unavailable.map((id) => (
                <Button
                  type="button"
                  className="secondary"
                  key={id}
                  onClick={() =>
                    update({
                      versionIds: settings.versionIds.filter((v) => v !== id),
                    })
                  }
                >
                  Remove unavailable skill {id.slice(0, 8)}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
      <label>
        Skill usage
        <select
          aria-label="Skill usage"
          value={settings.usageMode}
          onChange={(e) =>
            update({ usageMode: e.target.value as typeof settings.usageMode })
          }
        >
          <option value="always">Always load attached skills</option>
          <option value="automatic">Automatic — select relevant skills</option>
          <option value="disabled">Disabled</option>
        </select>
      </label>
      <div className="settings-hint">
        <span>How skills are used</span>
        <HelpTooltip label="About skill usage">
          Always loads instructions without a planning call, adding references
          while they fit. Automatic uses a bounded model call to select up to
          three relevant skills and reference files; selection failures skip
          skills. Disabled adds no skill context. Scripts are never executed.
        </HelpTooltip>
      </div>
      {settings.usageMode === "automatic" && (
        <label>
          When to use skills
          <textarea
            value={settings.usageInstructions}
            maxLength={2000}
            rows={3}
            onChange={(e) => update({ usageInstructions: e.target.value })}
            placeholder="Use the report-writing skill for formal summaries; skip it for greetings."
          />
        </label>
      )}
      <details>
        <summary>Advanced skill settings</summary>
        <ConfigureField
          field="config.skills.contextBudget"
          label="Skill context budget"
          issues={p.issues}
        >
          {(attributes) => (
            <input
              {...attributes}
              type="number"
              min={256}
              max={12000}
              value={settings.contextBudget}
              onChange={(event) =>
                update({ contextBudget: Number(event.target.value) })
              }
            />
          )}
        </ConfigureField>
        <p className="muted">
          Maximum tokens for loaded skills, also bounded by the model’s
          remaining context. Oversized instructions are skipped; references are
          added only when they fit.
        </p>
      </details>
      <p className="muted">
        Save and start a new Playground chat to use changed attachments.
        Uploading a new skill version never silently upgrades an agent.
      </p>
    </section>
  );
}
