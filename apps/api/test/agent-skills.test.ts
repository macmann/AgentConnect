import "./tracing-fixture.js";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { digest } from "../src/security.js";
import { config } from "../src/config.js";
import { agentConfig } from "@agentconnect/schemas/agents";
import {
  resolveAgentSkills,
  validateSkillSelection,
} from "../src/agent-skills.js";
import { executeAgentSnapshot } from "../src/workflow-agents.js";
import {
  creationCatalog,
  normalizeCreationReply,
} from "../src/creation-assistant.js";
import { modelSnapshot } from "../src/agents.js";
import { capturedSpans } from "./tracing-fixture.js";
import type { ProviderFactory, ChatProvider } from "@agentconnect/provider-sdk";
const org = randomUUID(),
  workspace = randomUUID(),
  foreign = randomUUID(),
  model = randomUUID();
const users = Object.fromEntries(
  ["builder", "viewer"].map((role) => [
    role,
    { id: randomUUID(), token: randomUUID() },
  ]),
);
const scope = { workspaceId: workspace, organizationId: org };
let skillId = "",
  v1 = "",
  v2 = "",
  agent = "",
  version = "",
  calls = 0;
let selection: unknown = null;
const systems: string[] = [];
const factory: ProviderFactory = () => ({
  async *stream(input) {
    calls++;
    systems.push(input.system);
    const text = input.system.startsWith(
      "Select relevant attached procedural skills",
    )
      ? typeof selection === "string"
        ? selection
        : JSON.stringify(selection)
      : input.system.includes("SKILL_MARKER_V1")
        ? "SKILL_V1_USED"
        : "NO_SKILL";
    yield { type: "token", text };
    yield { type: "usage", inputTokens: 25, outputTokens: 5 };
  },
});
const app = await buildApp({ providerFactory: factory });
let counter = 1;
async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  payload?: unknown,
  role = "builder",
) {
  return app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    remoteAddress: `192.0.2.${counter++}`,
    headers: {
      cookie: `session=${users[role]!.token}`,
      origin: config.WEB_ORIGIN,
    },
  });
}
async function upload(
  bytes: Uint8Array,
  name = "SKILL.md",
  existing = false,
  role = "builder",
) {
  const boundary = "skill-test-boundary";
  return app.inject({
    method: "POST",
    url: existing
      ? `/agent-skills/${skillId}/versions`
      : `/workspaces/${workspace}/agent-skills/upload`,
    remoteAddress: `192.0.2.${counter++}`,
    headers: {
      cookie: `session=${users[role]!.token}`,
      origin: config.WEB_ORIGIN,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}
const md = (marker: string) =>
  `---\nname: Report writing\ndescription: Write structured reports\n---\nUse ${marker}. Follow references/outline.md. Never invent figures.`;
const settings = (
  ids = [v1],
  mode: "always" | "automatic" | "disabled" = "always",
  budget = 6000,
) =>
  agentConfig.parse({
    modelId: model,
    skills: { versionIds: ids, usageMode: mode, contextBudget: budget },
    prompt: { role: "A helpful report assistant" },
  });
before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Agent skill fixture')`;
    for (const w of [workspace, foreign])
      await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${w},${org},'Skill workspace')`;
    for (const [role, u] of Object.entries(users)) {
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${u.id},${u.id + "@example.com"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${digest(u.token)},${u.id},now()+interval '1 hour')`;
      await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES(${randomUUID()},${org},${workspace},${u.id},${role})`;
    }
    await tx`INSERT INTO model_configurations(id,workspace_id,organization_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES(${model},${workspace},${org},'Skill model','openai-compatible','fixture','https://api.deepseek.com',32768,8192,${tx.json({ streaming: true, temperature: true, topP: true })})`;
  });
});
after(async () => {
  await sql.begin(async (tx) => {
    for (const table of [
      "messages",
      "agent_runs",
      "conversations",
      "deployments",
      "agent_versions",
      "agents",
      "agent_skill_versions",
      "agent_skills",
      "model_configurations",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(table)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    for (const u of Object.values(users))
      await tx`DELETE FROM users WHERE id=${u.id}`;
  });
  await app.close();
});
test("builders upload SKILL.md and ZIP versions; readers cannot manage, foreign workspaces cannot read", async () => {
  assert.equal(
    (await upload(strToU8(md("SKILL_MARKER_V1")), "SKILL.md", false, "viewer"))
      .statusCode,
    403,
  );
  const first = await upload(strToU8(md("SKILL_MARKER_V1")));
  assert.equal(first.statusCode, 201, first.body);
  skillId = first.json().id;
  v1 = first.json().versionId;
  const second = await upload(
    zipSync({
      "bundle/SKILL.md": strToU8(md("SKILL_MARKER_V2")),
      "bundle/references/outline.md": strToU8(
        "Use headings: Findings, Risks, Next steps",
      ),
      "bundle/scripts/run.py": strToU8("must_not_execute()"),
    }),
    "report.zip",
    true,
  );
  assert.equal(second.statusCode, 201, second.body);
  v2 = second.json().versionId;
  assert.ok(second.json().warnings.length);
  const detail = await call("GET", `/agent-skills/${skillId}`);
  assert.equal(detail.json().versions.length, 2);
  assert.deepEqual(detail.json().versions[0].ignored_files, ["scripts/run.py"]);
  const list = await call("GET", `/workspaces/${workspace}/agent-skills`);
  assert.equal(list.json()[0].version_id, v2);
  assert.equal(list.json()[0].versions.length, 2);
  assert.ok(!list.body.includes("SKILL_MARKER"));
  assert.equal(
    (await call("GET", `/workspaces/${foreign}/agent-skills`)).statusCode,
    403,
  );
  await assert.rejects(
    validateSkillSelection(settings().skills, {
      ...scope,
      workspaceId: foreign,
    }),
  );
  assert.equal(
    (
      await call(
        "PUT",
        `/agent-skills/${skillId}`,
        { enabled: false, publicAccess: false, revision: 2 },
        "viewer",
      )
    ).statusCode,
    403,
  );
  assert.equal((await upload(strToU8("not a zip"), "bad.zip")).statusCode, 400);
});
test("pinned versions remain immutable and normal draft, publish and public deployment rules apply", async () => {
  await assert.rejects(
    sql`UPDATE agent_skill_versions SET instructions='changed' WHERE id=${v1}`,
  );
  const created = await call("POST", `/workspaces/${workspace}/agents`, {
    name: "Skilled agent",
    config: settings(),
  });
  assert.equal(created.statusCode, 201, created.body);
  agent = created.json().id;
  const published = await call("POST", `/agents/${agent}/publish`, {
    revision: 1,
  });
  assert.equal(published.statusCode, 201, published.body);
  version = published.json().id;
  assert.equal(
    (
      await call("POST", `/agents/${agent}/deployments`, {
        name: "Public skilled agent",
        versionId: version,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("PUT", `/agent-skills/${skillId}`, {
        enabled: true,
        publicAccess: true,
        revision: 1,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await call("PUT", `/agent-skills/${skillId}`, {
        enabled: true,
        publicAccess: true,
        revision: 2,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call("POST", `/agents/${agent}/deployments`, {
        name: "Public skilled agent",
        versionId: version,
      })
    ).statusCode,
    201,
  );
  await assert.rejects(
    validateSkillSelection(settings([v1, v2]).skills, scope),
  );
  await assert.rejects(
    validateSkillSelection(settings([randomUUID()]).skills, scope),
  );
});
test("single-agent chat and workflow agent execution use pinned skills and record diagnostics without a selector call", async () => {
  const prior = calls;
  const chat = await call("POST", `/agents/${agent}/chat`, {
    message: "Write a report",
  });
  assert.equal(chat.statusCode, 200, chat.body);
  assert.match(chat.body, /SKILL_V1_USED/);
  assert.equal(calls, prior + 1);
  assert.ok(!systems.at(-1)!.includes("SKILL_MARKER_V2"));
  const [run] =
    await sql`SELECT context_breakdown FROM agent_runs WHERE workspace_id=${workspace} ORDER BY started_at DESC LIMIT 1`;
  assert.equal(run!.context_breakdown.skills.selected[0].versionId, v1);
  const result = await executeAgentSnapshot(
    settings(),
    await modelSnapshot(model, workspace),
    "Write a report",
    { ...scope, userId: users.builder!.id },
    new AbortController().signal,
    factory,
  );
  assert.equal(result.output, "SKILL_V1_USED");
  assert.ok(capturedSpans().some((span) => span.name === "skills.resolve"));
  assert.ok(
    capturedSpans().every(
      (span) => !JSON.stringify(span.attributes).includes("SKILL_MARKER_V1"),
    ),
  );
});
test("automatic mode loads only selected skills and references; invalid selections fall back without inventing files", async () => {
  const c = settings([v2], "automatic"),
    provider = factory({} as never),
    messages = [{ role: "user" as const, content: "Write a report" }];
  selection = { skills: [{ versionId: v2, files: ["references/outline.md"] }] };
  const chosen = await resolveAgentSkills(
    c,
    { contextWindow: 32768 },
    provider,
    messages,
    scope,
    new AbortController().signal,
  );
  assert.match(chosen.prompt, /SKILL_MARKER_V2/);
  assert.match(chosen.prompt, /Findings/);
  assert.ok(!chosen.prompt.includes("must_not_execute"));
  assert.deepEqual(chosen.details.selected[0]!.files, [
    "references/outline.md",
  ]);
  for (const bad of [
    { skills: [{ versionId: randomUUID(), files: [] }] },
    { skills: [{ versionId: v2, files: ["../secret"] }] },
    "not JSON",
  ]) {
    selection = bad;
    const result = await resolveAgentSkills(
      c,
      { contextWindow: 32768 },
      provider,
      messages,
      scope,
      new AbortController().signal,
    );
    assert.equal(result.prompt, "");
    assert.equal(result.details.status, "selection_fallback");
  }
  selection = { skills: [] };
  assert.equal(
    (
      await resolveAgentSkills(
        c,
        { contextWindow: 32768 },
        provider,
        messages,
        scope,
        new AbortController().signal,
      )
    ).prompt,
    "",
  );
});
test("AI-assisted drafts can attach only valid distinct skills, and bounded references do not crowd out instructions", async () => {
  const catalog = await creationCatalog(workspace, org);
  const request = {
    kind: "agent" as const,
    mode: "assisted" as const,
    messages: [{ role: "user" as const, content: "Use the reporting skill" }],
  };
  const proposed = {
    message: "Review this draft",
    agent: {
      name: "Reporter",
      modelId: model,
      prompt: { role: "Write reports" },
      skillVersionIds: [v1],
    },
  };
  const result = await normalizeCreationReply(
    proposed,
    request,
    catalog,
    workspace,
  );
  assert.equal(result.draft?.kind, "agent");
  assert.deepEqual(
    result.draft?.kind === "agent" ? result.draft.config.skills.versionIds : [],
    [v1],
  );
  await assert.rejects(
    normalizeCreationReply(
      { ...proposed, agent: { ...proposed.agent, skillVersionIds: [v1, v2] } },
      request,
      catalog,
      workspace,
    ),
  );
  const uploaded = await upload(
    zipSync({
      "SKILL.md": strToU8(md("BUDGET_MARKER")),
      "references/outline.md": strToU8("Long reference data ".repeat(1800)),
    }),
    "bounded.zip",
  );
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const bounded = await resolveAgentSkills(
    settings([uploaded.json().versionId], "always", 384),
    { contextWindow: 32768 },
    factory({} as never),
    [{ role: "user", content: "Report" }],
    scope,
    new AbortController().signal,
  );
  assert.match(bounded.prompt, /BUDGET_MARKER/);
  assert.ok(!bounded.prompt.includes("Long reference data"));
  assert.equal(bounded.details.selected[0]!.files.length, 0);
  assert.ok(
    bounded.details.skipped.some((item) =>
      item.reason.startsWith("reference_budget"),
    ),
  );
  await call("DELETE", `/agent-skills/${uploaded.json().id}`);
});
test("context budgets, disabled mode, live revocation and archive do not leak or block optional runtime skills", async () => {
  const provider: ChatProvider = {
    async *stream() {
      throw new Error("must not call selector");
    },
  };
  const signal = new AbortController().signal,
    messages = [{ role: "user" as const, content: "Report" }];
  const disabled = await resolveAgentSkills(
    settings([v1], "disabled"),
    { contextWindow: 32768 },
    provider,
    messages,
    scope,
    signal,
  );
  assert.equal(disabled.prompt, "");
  const limited = await resolveAgentSkills(
    settings(),
    { contextWindow: 300 },
    provider,
    messages,
    scope,
    signal,
  );
  const routedLimit = await resolveAgentSkills(
    settings(),
    { contextWindow: 32768, alternatives: [{ contextWindow: 300 }] },
    provider,
    messages,
    scope,
    signal,
  );
  assert.equal(routedLimit.prompt, "");
  assert.equal(limited.prompt, "");
  assert.ok(
    limited.details.skipped.some((item) => item.reason === "context_budget"),
  );
  assert.equal(
    (
      await call("PUT", `/agent-skills/${skillId}`, {
        enabled: true,
        publicAccess: false,
        revision: 3,
      })
    ).statusCode,
    200,
  );
  const privateSkill = await resolveAgentSkills(
    settings(),
    { contextWindow: 32768 },
    provider,
    messages,
    { ...scope, publicAccess: true },
    signal,
  );
  assert.equal(privateSkill.prompt, "");
  await call("PUT", `/agent-skills/${skillId}`, {
    enabled: false,
    publicAccess: false,
    revision: 4,
  });
  const revoked = await resolveAgentSkills(
    settings(),
    { contextWindow: 32768 },
    provider,
    messages,
    scope,
    signal,
  );
  assert.equal(revoked.prompt, "");
  assert.equal(revoked.details.skipped[0]!.reason, "unavailable");
  await assert.rejects(validateSkillSelection(settings().skills, scope));
  assert.equal(
    (await call("DELETE", `/agent-skills/${skillId}`)).statusCode,
    200,
  );
  assert.equal(
    (await call("GET", `/workspaces/${workspace}/agent-skills`)).json().length,
    0,
  );
  assert.equal(
    (
      await sql`SELECT count(*)::int AS total FROM agent_skill_versions WHERE skill_id=${skillId}`
    )[0]!.total,
    2,
  );
});
