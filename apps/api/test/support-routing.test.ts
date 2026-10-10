import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { digest } from "../src/security.js";
import { processSupportRouting } from "../src/support/routing.js";
if (config.NODE_ENV === "production")
  throw new Error("Tests refuse production");
const org = randomUUID(),
  workspace = randomUUID(),
  sibling = randomUUID(),
  agent = randomUUID(),
  users: Record<string, string> = {},
  sessions: Record<string, string> = {},
  base = `/workspaces/${workspace}/support`,
  remoteAddress = `127.${randomBytes(1)[0]}.${randomBytes(1)[0]}.72`;
const app = await buildApp();
async function call(
  method: "GET" | "POST" | "PUT" | "PATCH",
  url: string,
  payload?: unknown,
  role = "owner",
) {
  return app.inject({
    method,
    url,
    remoteAddress,
    headers: {
      origin: config.WEB_ORIGIN,
      cookie: `session=${sessions[role]}`,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });
}
async function profile(role: string, extra: Record<string, unknown> = {}) {
  const r = await call("PUT", `${base}/operators/${users[role]!}/profile`, {
    capacityLimit: 5,
    languages: ["en"],
    ...extra,
  });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function presence(role: string, status = "available") {
  const r = await call(
    "POST",
    `${base}/operators/${users[role]!}/presence`,
    { status },
    role,
  );
  assert.equal(r.statusCode, 200, r.body);
}
async function queue(
  strategy = "round_robin",
  extra: Record<string, unknown> = {},
) {
  const r = await call("POST", base + "/queues", {
    name: "Queue " + randomUUID(),
    routingStrategy: strategy,
    assignmentMode: "automatic",
    ...extra,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().id as string;
}
async function members(q: string, roles = ["a", "b"]) {
  const r = await call("PUT", `${base}/queues/${q}/members`, {
    members: roles.map((role) => ({ userId: users[role] })),
  });
  assert.equal(r.statusCode, 200, r.body);
}
async function supportCase(q: string | null = null, conversationId?: string) {
  const c = conversationId ?? randomUUID();
  if (!conversationId)
    await sql`INSERT INTO conversations(id,organization_id,workspace_id,agent_id,user_id,config_snapshot,model_snapshot) VALUES (${c},${org},${workspace},${agent},${users.owner!},'{}','{}')`;
  const r = await call("POST", base + "/cases", {
    conversationId: c,
    queueId: q,
  });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}
async function route(id: string) {
  const r = await call("POST", `${base}/cases/${id}/route`, {});
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
}
async function setup(q: string) {
  await profile("a");
  await profile("b");
  await presence("a");
  await presence("b");
  await members(q);
}
before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO organizations(id,name) VALUES (${org},'Routing fixtures')`;
    for (const w of [workspace, sibling])
      await tx`INSERT INTO workspaces(id,organization_id,name) VALUES (${w},${org},'Routing workspace')`;
    for (const role of ["owner", "a", "b", "analyst", "outsider"]) {
      users[role] = randomUUID();
      sessions[role] = randomUUID();
      await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES (${users[role]!},${users[role] + "@example.invalid"},${role},'unused',now())`;
      await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES (${digest(sessions[role]!)},${users[role]!},now()+interval '1 hour')`;
      if (role !== "outsider")
        await tx`INSERT INTO memberships(id,organization_id,workspace_id,user_id,role) VALUES (${randomUUID()},${org},${role === "owner" ? null : workspace},${users[role]!},${role === "a" || role === "b" ? "operator" : role})`;
    }
    await tx`INSERT INTO agents(id,organization_id,workspace_id,name,description,public_description,draft_config,created_by) VALUES (${agent},${org},${workspace},'Fixture','Fixture','Fixture','{}',${users.owner!})`;
  });
});
beforeEach(async () => {
  await sql`DELETE FROM handoff_events WHERE organization_id=${org}`;
  await sql`DELETE FROM conversations WHERE organization_id=${org}`;
  await sql`DELETE FROM support_queues WHERE organization_id=${org}`;
  await sql`DELETE FROM operator_profiles WHERE organization_id=${org}`;
  await sql`DELETE FROM support_skills WHERE organization_id=${org}`;
});
after(async () => {
  await sql.begin(async (tx) => {
    for (const t of [
      "handoff_events",
      "conversations",
      "agents",
      "audit_events",
      "memberships",
      "workspaces",
    ])
      await tx`DELETE FROM ${tx(t)} WHERE organization_id=${org}`;
    await tx`DELETE FROM organizations WHERE id=${org}`;
    for (const u of Object.values(users))
      await tx`DELETE FROM users WHERE id=${u}`;
  });
  await app.close();
});
test("Profiles, skills and queue membership enforce roles, tenant references and bounded schemas", async () => {
  assert.equal(
    (await call("PUT", `${base}/operators/${users.a!}/profile`, {}, "a"))
      .statusCode,
    403,
  );
  assert.equal(
    (await call("PUT", `${base}/operators/${users.outsider!}/profile`, {}))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await call("PUT", `${base}/operators/${users.a!}/profile`, {
        capacityLimit: 0,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("PUT", `${base}/operators/${users.a!}/profile`, {
        timezone: "not/a/timezone",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("PUT", `${base}/operators/${users.a!}/profile`, {
        languages: ["en", "en"],
      })
    ).statusCode,
    400,
  );
  const foreign = randomUUID();
  await sql`INSERT INTO support_skills(id,workspace_id,organization_id,name) VALUES (${foreign},${sibling},${org},'foreign')`;
  assert.equal(
    (
      await call("PUT", `${base}/operators/${users.a!}/profile`, {
        skills: [{ skillId: foreign, proficiency: 5 }],
      })
    ).statusCode,
    400,
  );
  await profile("a");
  assert.equal(
    (
      await call("POST", `${base}/operators/${users.a!}/presence`, {
        status: "available",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await call("GET", base + "/profiles", undefined, "analyst")).statusCode,
    200,
  );
  assert.equal(
    (await call("POST", base + "/skills", { name: "Billing" }, "analyst"))
      .statusCode,
    403,
  );
  const q = await queue();
  assert.equal(
    (
      await call("PUT", `${base}/queues/${q}/members`, {
        members: [{ userId: users.b! }],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call("PATCH", `${base}/queues/${q}`, {
        routingConfig: { requiredSkills: [foreign] },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await call(
        "GET",
        `/workspaces/${sibling}/support/operators/${users.a!}/profile`,
      )
    ).json().profile,
    null,
  );
  await assert.rejects(
    sql`INSERT INTO operator_skills(organization_id,workspace_id,user_id,skill_id,proficiency) VALUES (${org},${workspace},${users.a!},${foreign},5)`,
    (e: { code: string }) => e.code === "23503",
  );
});
test("Fresh available presence is required; stale, busy, unavailable and disabled operators never route", async () => {
  const q = await queue();
  await setup(q);
  await presence("a", "busy");
  await sql`UPDATE operator_profiles SET presence_expires_at=now()-interval '1 second' WHERE workspace_id=${workspace} AND user_id=${users.b!}`;
  const s = await supportCase(q);
  assert.equal((await route(s.id)).assigned, false);
  const p = (await call("GET", `${base}/operators/${users.b!}/profile`)).json()
    .profile;
  assert.equal(p.effective_presence, "offline");
  await presence("b");
  const routed = await route(s.id);
  assert.equal(routed.operatorId, users.b!);
  await profile("a", { enabled: false });
  assert.equal(
    (
      await call(
        "POST",
        `${base}/operators/${users.a!}/presence`,
        { status: "available" },
        "a",
      )
    ).statusCode,
    409,
  );
  const another = await supportCase(q);
  assert.equal(
    (
      await call("POST", `${base}/cases/${another.id}/assign`, {
        operatorId: users.a!,
      })
    ).statusCode,
    409,
  );
});
test("Concurrent automatic and manual assignments across conversations cannot exceed reserved capacity", async () => {
  const q = await queue();
  await profile("a", { capacityLimit: 1 });
  await presence("a");
  await members(q, ["a"]);
  const one = await supportCase(q),
    two = await supportCase(q);
  const results = await Promise.all([route(one.id), route(two.id)]);
  assert.equal(results.filter((r) => r.assigned).length, 1);
  const [count] =
    await sql`SELECT count(*)::int AS n FROM support_cases WHERE workspace_id=${workspace} AND assigned_operator_id=${users.a!} AND status='assigned'`;
  assert.equal(count!.n, 1);
  const unassigned = results[0].assigned ? two : one;
  assert.equal(
    (await call("POST", `${base}/cases/${unassigned.id}/claim`, {}, "a"))
      .statusCode,
    409,
  );
  const assigned = results[0].assigned ? one : two;
  assert.equal(
    (
      await call(
        "POST",
        `${base}/cases/${assigned.id}/status`,
        { status: "active" },
        "a",
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        `${base}/cases/${assigned.id}/resolve`,
        { summary: "Finished" },
        "a",
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await call("POST", `${base}/cases/${unassigned.id}/claim`, {}, "a"))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        `${base}/cases/${assigned.id}/status`,
        { status: "active" },
        "a",
      )
    ).statusCode,
    409,
  );
});
test("Round robin fairness persists across routing calls and queue membership reconfiguration", async () => {
  const q = await queue();
  await setup(q);
  const assigned: string[] = [];
  for (let i = 0; i < 4; i++) {
    const s = await supportCase(q);
    assigned.push((await route(s.id)).operatorId);
    if (i === 1) await members(q);
  }
  assert.notEqual(assigned[0], assigned[1]);
  assert.equal(assigned[0], assigned[2]);
  assert.equal(assigned[1], assigned[3]);
  const [events] =
    await sql`SELECT count(*)::int AS n FROM support_events WHERE workspace_id=${workspace} AND type='routing.assigned'`;
  assert.equal(events!.n, 4);
});
test("Least loaded uses free capacity ratio and skill/language constraints remain hard", async () => {
  const skill = (
    await call("POST", base + "/skills", { name: "Billing" })
  ).json().id;
  const q = await queue("least_loaded", {
    routingConfig: { requiredSkills: [skill], requiredLanguage: "my" },
  });
  await profile("a", {
    capacityLimit: 5,
    languages: ["my"],
    skills: [{ skillId: skill, proficiency: 2 }],
  });
  await profile("b", {
    capacityLimit: 5,
    languages: ["en"],
    skills: [{ skillId: skill, proficiency: 5 }],
  });
  await presence("a");
  await presence("b");
  await members(q);
  const first = await supportCase(q);
  assert.equal((await route(first.id)).operatorId, users.a!);
  await profile("b", {
    languages: ["my"],
    skills: [{ skillId: skill, proficiency: 5 }],
  });
  const second = await supportCase(q);
  assert.equal((await route(second.id)).operatorId, users.b!);
  await call("PUT", base + "/skills/" + skill, {
    name: "Billing",
    enabled: false,
  });
  const third = await supportCase(q);
  assert.equal((await route(third.id)).assigned, false);
});
test("Skill routing ranks proficiency and hybrid weights expose normalized factors", async () => {
  const skill = (
      await call("POST", base + "/skills", { name: "Technical" })
    ).json().id,
    q = await queue("skill_based", {
      assignmentMode: "recommend",
      routingConfig: { requiredSkills: [skill] },
    });
  await profile("a", {
    skills: [{ skillId: skill, proficiency: 1 }],
    languages: ["en"],
  });
  await profile("b", {
    skills: [{ skillId: skill, proficiency: 5 }],
    languages: ["my"],
  });
  await presence("a");
  await presence("b");
  await members(q);
  const s = await supportCase(q),
    recommend = (await call("GET", `${base}/cases/${s.id}/routing`)).json();
  assert.equal(recommend.candidates[0].userId, users.b!);
  assert.equal(
    (await call("GET", `${base}/cases/${s.id}`)).json().status,
    "queued",
  );
  const patch = await call("PATCH", `${base}/queues/${q}`, {
    routingStrategy: "hybrid",
    routingConfig: {
      preferredLanguage: "en",
      weights: {
        skill: 0,
        language: 100,
        capacity: 0,
        proficiency: 0,
        priority: 0,
        fairness: 0,
        continuity: 0,
      },
    },
  });
  assert.equal(patch.statusCode, 200, patch.body);
  const result = await route(s.id);
  assert.equal(result.operatorId, users.a!);
  assert.equal(result.score, 100);
  assert.equal(result.factors.language, 1);
  const stored = (await call("GET", `${base}/cases/${s.id}`)).json();
  assert.equal(stored.routing_explanation.operatorId, users.a!);
  assert.equal(stored.routing_score, 100);
});
test("Automatic worker picks default-queue requests once; manual and recommendation queues stay queued", async () => {
  const q = await queue("round_robin", { isDefault: true });
  await setup(q);
  const s = await supportCase();
  assert.equal(s.queue_id, q);
  await processSupportRouting();
  await processSupportRouting();
  assert.equal(
    (await call("GET", `${base}/cases/${s.id}`)).json().status,
    "assigned",
  );
  const [events] =
    await sql`SELECT count(*)::int AS n FROM support_events WHERE support_case_id=${s.id} AND type='routing.assigned'`;
  assert.equal(events!.n, 1);
  const manual = await queue("manual"),
    recommend = await queue("hybrid", { assignmentMode: "recommend" });
  const a = await supportCase(manual),
    b = await supportCase(recommend);
  await processSupportRouting();
  for (const id of [a.id, b.id])
    assert.equal(
      (await call("GET", `${base}/cases/${id}`)).json().status,
      "queued",
    );
});
test("Live membership revocation prevents routing; failed combined configuration rolls back all policy changes", async () => {
  const q = await queue();
  await setup(q);
  await sql`UPDATE memberships SET role='analyst' WHERE user_id=${users.a!} AND workspace_id=${workspace}`;
  try {
    const s = await supportCase(q);
    assert.equal((await route(s.id)).operatorId, users.b!);
    assert.equal(
      (
        await call(
          "POST",
          `${base}/operators/${users.a!}/presence`,
          { status: "available" },
          "a",
        )
      ).statusCode,
      403,
    );
    const bad = await call("PATCH", `${base}/queues/${q}`, {
      routingStrategy: "hybrid",
      isDefault: true,
      members: [{ userId: users.outsider! }],
    });
    assert.equal(bad.statusCode, 403);
    const [unchanged] = await sql`SELECT * FROM support_queues WHERE id=${q}`;
    assert.equal(unchanged!.routing_strategy, "round_robin");
    assert.equal(unchanged!.is_default, false);
  } finally {
    await sql`UPDATE memberships SET role='operator' WHERE user_id=${users.a!} AND workspace_id=${workspace}`;
  }
});

test("Browser preflight permits authenticated PATCH queue configuration", async () => {
  const r = await app.inject({
    method: "OPTIONS",
    url: base + "/queues/" + randomUUID(),
    headers: {
      origin: config.WEB_ORIGIN,
      "access-control-request-method": "PATCH",
      "access-control-request-headers": "content-type",
    },
    remoteAddress,
  });
  assert.equal(r.statusCode, 204, r.body);
  assert.match(String(r.headers["access-control-allow-methods"]), /PATCH/);
  assert.equal(r.headers["access-control-allow-origin"], config.WEB_ORIGIN);
});
test("Concurrent manual claims reserve one slot across different cases", async () => {
  await profile("a", { capacityLimit: 1 });
  const one = await supportCase(),
    two = await supportCase();
  const replies = await Promise.all([
    call("POST", `${base}/cases/${one.id}/claim`, {}, "a"),
    call("POST", `${base}/cases/${two.id}/claim`, {}, "a"),
  ]);
  assert.deepEqual(replies.map((r) => r.statusCode).sort(), [200, 409]);
});
test("Backlog polling defers unavailable cases so later eligible queues are considered", async () => {
  const unavailable = await queue(),
    eligible = await queue();
  await profile("a");
  await presence("a");
  await members(eligible, ["a"]);
  for (let i = 0; i < 30; i++) await supportCase(unavailable);
  const later = await supportCase(eligible);
  await processSupportRouting();
  assert.equal(
    (await call("GET", `${base}/cases/${later.id}`)).json().status,
    "queued",
  );
  await processSupportRouting();
  assert.equal(
    (await call("GET", `${base}/cases/${later.id}`)).json().status,
    "assigned",
  );
});
test("Continuity prefers the prior specialist without overriding language or capacity eligibility", async () => {
  const q = await queue("hybrid", {
    assignmentMode: "recommend",
    routingConfig: {
      weights: {
        skill: 0,
        language: 0,
        capacity: 0,
        proficiency: 0,
        priority: 0,
        fairness: 0,
        continuity: 100,
      },
    },
  });
  await setup(q);
  const prior = await supportCase(q);
  assert.equal(
    (await call("POST", `${base}/cases/${prior.id}/claim`, {}, "a")).statusCode,
    200,
  );
  assert.equal(
    (
      await call(
        "POST",
        `${base}/cases/${prior.id}/resolve`,
        { summary: "Prior intervention" },
        "a",
      )
    ).statusCode,
    200,
  );
  const again = await supportCase(q, prior.conversation_id);
  assert.equal((await route(again.id)).operatorId, users.a!);
  const second = await supportCase(q);
  await profile("a", { capacityLimit: 1 });
  assert.equal((await route(second.id)).operatorId, users.b!);
});
