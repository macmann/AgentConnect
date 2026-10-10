import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTeamsAdapter,
  createSlackAdapter,
} from "../src/messaging-adapters.js";
import {
  oneDriveCredential,
  slackCredential,
  teamsSelection,
  slackSelection,
} from "@agentconnect/schemas/connectors";
import { ConnectorError } from "../src/connector-adapters.js";
import { messagingFixture } from "./messaging-fixture.js";
const code = (expected: string) => (e: unknown) =>
  e instanceof ConnectorError && e.code === expected;
for (const kind of ["teams", "slack"] as const) {
  const adapter = (f: ReturnType<typeof messagingFixture>, limit = 10) =>
    kind === "teams"
      ? createTeamsAdapter(
          teamsSelection.parse({ ...f.selection, maxObjects: limit }),
          oneDriveCredential.parse(f.credential),
          f.transport,
        )
      : createSlackAdapter(
          slackSelection.parse({ ...f.selection, maxObjects: limit }),
          slackCredential.parse(f.credential),
          f.transport,
        );
  test(`${kind} imports messages and replies with provenance, stable fingerprints and bounded snapshots`, async () => {
    const f = messagingFixture(kind),
      a = adapter(f),
      signal = AbortSignal.timeout(10000);
    try {
      const docs = [...(await a.list(signal))];
      assert.equal(docs.length, 2);
      const bytes = await a.read(docs[0]!, signal),
        text = Buffer.from(bytes).toString();
      assert.ok(text.includes(f.state.text));
      assert.ok(!text.includes("unsafe()"));
      assert.ok(
        text.includes(f.selection.channelId) ||
          text.includes(encodeURIComponent(f.selection.channelId)),
      );
      assert.equal(bytes.length, docs[0]!.size);
      assert.equal(
        (await a.list(signal))[0]!.fingerprint,
        docs[0]!.fingerprint,
      );
      f.state.text = "Updated refunds.";
      assert.notEqual(
        (await a.list(signal))[0]!.fingerprint,
        docs[0]!.fingerprint,
      );
      await assert.rejects(
        a.read(docs[0]!, signal),
        code("CONNECTOR_OBJECT_CHANGED"),
      );
      assert.equal(f.closed, f.requests.length);
      assert.ok(
        f.requests
          .filter((r) => r.method === "GET")
          .every(
            (r) =>
              new URL(r.url).hostname ===
              (kind === "teams" ? "graph.microsoft.com" : "slack.com"),
          ),
      );
      if (kind === "teams")
        assert.equal(f.requests.filter((r) => r.method === "POST").length, 1);
      else
        assert.ok(
          f.requests.every(
            (r) => r.method === "GET" && !r.url.includes("xoxp"),
          ),
        );
    } finally {
      a.close();
    }
  });
  test(`${kind} counts replies toward the complete scan limit`, async () => {
    const f = messagingFixture(kind),
      a = adapter(f, 1);
    try {
      await assert.rejects(
        a.list(AbortSignal.timeout(10000)),
        code("CONNECTOR_SOURCE_LIMIT"),
      );
    } finally {
      a.close();
    }
  });
  test(`${kind} fails safely on denied access and rejects foreign channels/workspaces`, async () => {
    const f = messagingFixture(kind),
      a = adapter(f),
      s = AbortSignal.timeout(10000);
    try {
      f.state.denied = true;
      await assert.rejects(a.list(s), code("CONNECTOR_ACCESS_DENIED"));
      f.state.denied = false;
      f.state.foreign = true;
      await assert.rejects(
        a.list(s),
        code(
          kind === "teams"
            ? "CONNECTOR_CHANNEL_MISMATCH"
            : "CONNECTOR_WORKSPACE_MISMATCH",
        ),
      );
    } finally {
      a.close();
    }
  });
  test(`${kind} rejects invalid reply parents and incomplete or looping pagination`, async () => {
    const f = messagingFixture(kind),
      a = adapter(f),
      s = AbortSignal.timeout(10000);
    try {
      f.state.invalidParent = true;
      await assert.rejects(a.list(s), code("CONNECTOR_INVALID_LISTING"));
      f.state.invalidParent = false;
      f.state.next =
        kind === "teams"
          ? "https://foreign.example/token-leak"
          : "repeat-cursor";
      await assert.rejects(a.list(s), code("CONNECTOR_INVALID_LISTING"));
      assert.ok(
        !f.requests.some((r) => new URL(r.url).hostname === "foreign.example"),
      );
    } finally {
      a.close();
    }
  });
  test(`${kind} complete empty inventory permits reconciliation and cancelled scans abort`, async () => {
    const f = messagingFixture(kind),
      a = adapter(f);
    try {
      f.state.visible = false;
      assert.equal((await a.list(AbortSignal.timeout(10000))).length, 0);
      await assert.rejects(
        a.list(AbortSignal.abort()),
        code("CONNECTOR_CANCELLED"),
      );
    } finally {
      a.close();
    }
  });
  test(`${kind} excludes shared channel sources`, async () => {
    const f = messagingFixture(kind),
      a = adapter(f);
    f.state.shared = true;
    try {
      await assert.rejects(
        a.list(AbortSignal.timeout(10000)),
        code(
          kind === "teams"
            ? "CONNECTOR_INVALID_LISTING"
            : "CONNECTOR_CHANNEL_MISMATCH",
        ),
      );
    } finally {
      a.close();
    }
  });
}
test("Slack requires a user credential; selected channel schemas reject path injection", () => {
  assert.equal(
    slackCredential.safeParse({ token: "xoxb-bot-token" }).success,
    false,
  );
  assert.equal(
    slackSelection.safeParse({ teamId: "TFIXTURE", channelId: "C../escape" })
      .success,
    false,
  );
  assert.equal(
    teamsSelection.safeParse({
      teamId: "common",
      channelId: "19:fixture@thread.tacv2",
    }).success,
    false,
  );
});

test("Teams soft-deleted messages with null bodies are reconciled without hiding surviving replies", async () => {
  const f = messagingFixture("teams");
  f.state.deleted = true;
  const a = createTeamsAdapter(
    teamsSelection.parse(f.selection),
    oneDriveCredential.parse(f.credential),
    f.transport,
  );
  try {
    const docs = await a.list(AbortSignal.timeout(10000));
    assert.equal(docs.length, 1);
    assert.equal(docs[0]!.key, "101");
  } finally {
    a.close();
  }
});
test("Slack thread broadcasts also present in reply history import once with thread provenance", async () => {
  const f = messagingFixture("slack");
  f.state.broadcast = true;
  const a = createSlackAdapter(
    slackSelection.parse(f.selection),
    slackCredential.parse(f.credential),
    f.transport,
  );
  try {
    const docs = await a.list(AbortSignal.timeout(10000));
    assert.equal(docs.length, 2);
    assert.ok(
      Buffer.from(await a.read(docs[1]!, AbortSignal.timeout(10000)))
        .toString()
        .includes("Thread: 1791580000.000001"),
    );
  } finally {
    a.close();
  }
});
