import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { chatInput, agentConfig } from "@agentconnect/schemas/agents";
import {
  prepareChatAttachments,
  protectImages,
  restoreImages,
  capAttachmentHistory,
} from "../src/chat-attachments.js";
import { messageTokens, tokenCount } from "../src/context-control.js";
import { buildApp } from "../src/app.js";
import { sql } from "../src/db.js";
import { digest } from "../src/security.js";
import { config } from "../src/config.js";
import type { ChatMessage, ChatRequest } from "@agentconnect/provider-sdk";
if (config.NODE_ENV === "production") throw Error("Tests refuse production");
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=";
const photo = { name: "photo.png", data: png };
const doc = {
  name: "notes.txt",
  data: Buffer.from("The meeting starts at 14:30.").toString("base64"),
};
const signal = () => AbortSignal.timeout(10000);

test("Documents are extracted once and photos retain native provider bytes", async () => {
  const parsed = await prepareChatAttachments([doc, photo], signal());
  assert.match(parsed.context, /14:30/);
  const markdown = {
    name: "meeting.md",
    data: Buffer.from("# Meeting title\n\nMeet at 14:30.").toString("base64"),
  };
  assert.match(
    (await prepareChatAttachments([markdown], signal())).context,
    /Meeting title/,
  );
  assert.equal(parsed.images[0]!.data, png);
  assert.equal(parsed.metadata[1]!.kind, "image");
  const docx = {
    name: "notes.docx",
    data: Buffer.from(
      zipSync({
        "word/document.xml": strToU8(
          '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Word attachment content</w:t></w:r></w:p></w:body></w:document>',
        ),
      }),
    ).toString("base64"),
  };
  assert.match(
    (await prepareChatAttachments([docx], signal())).context,
    /Word attachment content/,
  );
  const encrypted = protectImages(parsed.images, "message-a")!;
  assert(!JSON.stringify(encrypted).includes(png));
  assert.deepEqual(restoreImages(encrypted, "message-a"), parsed.images);
  assert.throws(() => restoreImages(encrypted, "message-b"));
});
test("Unsafe, malformed and oversized files are rejected before model execution", async () => {
  for (const file of [
    { name: "x.exe", data: doc.data },
    { name: "x.png", data: doc.data },
    { name: "x.pdf", data: doc.data },
    { name: "x.txt", data: "***invalid***" },
  ])
    await assert.rejects(prepareChatAttachments([file], signal()));
  assert.equal(
    chatInput.safeParse({
      message: "test",
      attachments: [{ name: "../secret.txt", data: doc.data }],
    }).success,
    false,
  );
  assert.equal(
    chatInput.safeParse({ message: "test", attachments: Array(7).fill(doc) })
      .success,
    false,
  );
  await assert.rejects(
    prepareChatAttachments(
      [
        {
          name: "huge.txt",
          data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64"),
        },
      ],
      signal(),
    ),
  );
});
test("Image context reserves space and bounded history preserves the current upload", () => {
  const image = {
    mimeType: "image/png" as const,
    data: png,
    byteSize: 4 * 1024 * 1024,
  };
  const messages: ChatMessage[] = Array.from({ length: 8 }, () => ({
    role: "user",
    content: "photo",
    images: [image],
  }));
  assert(messageTokens(messages[0]!, "conservative") > 8000);
  assert.equal(tokenCount("A".repeat(40000), "o200k_base"), 40000);
  const { kept, removed } = capAttachmentHistory(messages);
  assert.equal(kept.length, 4);
  assert.equal(removed.length, 4);
  assert.equal(kept.at(-1), messages.at(-1));
});
const org = randomUUID(),
  workspace = randomUUID(),
  owner = randomUUID(),
  session = randomUUID(),
  model = randomUUID(),
  agent = randomUUID(),
  version = randomUUID(),
  deployment = randomUUID();
let requests: ChatRequest[] = [];
let servedModel = "";
const app = await buildApp({
  embeddingFactory: () => ({
    async embed(texts) {
      return texts.map(() => [1, 0, 0]);
    },
  }),
  providerFactory: (connection) => ({
    async *stream(input) {
      servedModel = connection.modelId;
      requests.push(input);
      yield { type: "token", text: "I can read the uploaded files." };
      yield { type: "usage", inputTokens: 20, outputTokens: 10 };
    },
  }),
});
const c = agentConfig.parse({ modelId: model });
before(async () => {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO users(id,email,name,password_hash,verified_at) VALUES(${owner},${owner + "@test.invalid"},'Attachment user','unused',now())`;
    await tx`INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(${digest(session)},${owner},now()+interval '1 hour')`;
    await tx`INSERT INTO organizations(id,name) VALUES(${org},'Attachment tests')`;
    await tx`INSERT INTO workspaces(id,organization_id,name) VALUES(${workspace},${org},'Attachment workspace')`;
    await tx`INSERT INTO memberships(id,organization_id,user_id,role) VALUES(${randomUUID()},${org},${owner},'owner')`;
    await tx`INSERT INTO model_configurations(id,workspace_id,organization_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES(${model},${workspace},${org},'Vision','openai-compatible','vision','https://example.com',65536,4096,${tx.json({ temperature: true, topP: true, imageInput: true })})`;
    await tx`INSERT INTO agents(id,workspace_id,organization_id,name,description,public_description,draft_config,created_by) VALUES(${agent},${workspace},${org},'Upload agent','','',${tx.json(c)},${owner})`;
    await tx`INSERT INTO agent_versions(id,agent_id,workspace_id,organization_id,version,name,public_description,config,model_snapshot,model_id,published_by) VALUES(${version},${agent},${workspace},${org},1,'Upload agent','',${tx.json(c)},${tx.json({ id: model, provider: "openai-compatible", modelId: "vision", baseUrl: "https://example.com", secretId: null, contextWindow: 65536, maxOutputTokens: 4096, capabilities: { temperature: true, topP: true, imageInput: true } })},${model},${owner})`;
    await tx`INSERT INTO deployments(id,workspace_id,organization_id,agent_id,version_id,name,environment,widget_settings) VALUES(${deployment},${workspace},${org},${agent},${version},'Attachment widget','development',${tx.json({ enabled: true, allowedOrigins: [config.WEB_ORIGIN] })})`;
  });
});
function frames(body: string) {
  return body
    .split("\n\n")
    .filter((x) => x.startsWith("event:"))
    .map((x) => ({
      event: x.split("\n")[0]!.slice(7),
      data: JSON.parse(x.split("\n")[1]!.slice(6)),
    }));
}
const send = (path: string, body: unknown, token?: string) =>
  app.inject({
    method: "POST",
    url: path,
    headers: {
      origin: config.WEB_ORIGIN,
      "content-type": "application/json",
      cookie: `session=${session}`,
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    payload: JSON.stringify(body),
  });
test("Playground and widget deliver attachments, retain them on follow-up, and expose metadata only", async () => {
  for (const endpoint of [
    `/agents/${agent}/chat`,
    `/public/widgets/${deployment}/chat`,
  ]) {
    requests = [];
    const first = await send(endpoint, {
      message: "Read my files",
      attachments: [doc, photo],
    });
    assert.equal(first.statusCode, 200, first.body);
    const events = frames(first.body);
    assert(
      events.some((x) => x.event === "done"),
      first.body,
    );
    const meta = events.find((x) => x.event === "meta")!.data;
    assert.match(requests.at(-1)!.messages.at(-1)!.content, /14:30/);
    assert.equal(requests.at(-1)!.messages.at(-1)!.images![0]!.data, png);
    const [message] =
      await sql`SELECT id,content,attachments,attachment_payload FROM messages WHERE conversation_id=${meta.conversationId} AND role='user'`;
    assert.equal(message!.content, "Read my files");
    assert.equal(message!.attachments.length, 2);
    assert(!JSON.stringify(message!.attachment_payload).includes(png));
    const second = await send(
      endpoint,
      { message: "And what time was it?", conversationId: meta.conversationId },
      meta.guestToken,
    );
    assert(
      frames(second.body).some((x) => x.event === "done"),
      second.body,
    );
    assert(requests.at(-1)!.messages.some((m) => m.images?.[0]?.data === png));
    const history = await app.inject({
      method: "GET",
      url: `/conversations/${meta.conversationId}/messages`,
      headers: { cookie: `session=${session}` },
    });
    assert.equal(history.statusCode, 200);
    assert.equal(history.json()[0].attachments[0].name, "notes.txt");
    assert(!history.body.includes(png));
    assert(!history.body.includes("attachment_payload"));
  }
});
test("Text-only models accept documents but reject photos with a clear error", async () => {
  await sql`UPDATE model_configurations SET capabilities=${sql.json({ temperature: true, topP: true })} WHERE id=${model}`;
  const image = await send(`/agents/${agent}/chat`, {
    message: "photo",
    attachments: [photo],
  });
  assert.equal(image.statusCode, 400);
  assert.match(image.body, /does not support photos/);
  const text = await send(`/agents/${agent}/chat`, {
    message: "notes",
    attachments: [doc],
  });
  assert.equal(text.statusCode, 200);
  assert(frames(text.body).some((x) => x.event === "done"));
});
test("Chat upload limits accept documents larger than the default API body limit", async () => {
  const response = await send(`/agents/${agent}/chat`, {
    message: "Read this document",
    attachments: [
      {
        name: "large.txt",
        data: Buffer.from("A".repeat(40000)).toString("base64"),
      },
    ],
  });
  assert.equal(response.statusCode, 200, response.body);
  assert(
    frames(response.body).some((f) => f.event === "done"),
    response.body,
  );
});
test("Image requests bypass a text-only routed model and use its configured vision fallback", async () => {
  const alternative = randomUUID();
  await sql`INSERT INTO model_configurations(id,workspace_id,organization_id,name,provider,model_id,base_url,context_window,max_output_tokens,capabilities) VALUES(${alternative},${workspace},${org},'Vision fallback','openai-compatible','vision-fallback','https://example.com',65536,4096,${sql.json({ temperature: true, topP: true, imageInput: true })})`;
  await sql`UPDATE agents SET draft_config=${sql.json(agentConfig.parse({ ...c, modelRouting: { fallbackModelIds: [alternative] } }))} WHERE id=${agent}`;
  const response = await send(`/agents/${agent}/chat`, {
    message: "Read this photo",
    attachments: [photo],
  });
  assert.equal(response.statusCode, 200, response.body);
  assert(
    frames(response.body).some((f) => f.event === "done"),
    response.body,
  );
  assert.equal(servedModel, "vision-fallback");
});
test("Standard chat can answer uploaded documents when attached knowledge has no matches", async () => {
  const embedding = randomUUID(),
    base = randomUUID();
  await sql`INSERT INTO embedding_models(id,workspace_id,organization_id,name,provider,model_id,base_url,dimensions) VALUES(${embedding},${workspace},${org},'Attachment fixture','openai-compatible','embedding','https://example.com',3)`;
  await sql`INSERT INTO knowledge_bases(id,workspace_id,organization_id,name,description,embedding_model_id,dimensions,chunk_size,chunk_overlap,chunk_strategy) VALUES(${base},${workspace},${org},'Empty knowledge','',${embedding},3,1600,200,'recursive')`;
  await sql`UPDATE agents SET draft_config=${sql.json(agentConfig.parse({ ...c, rag: { knowledgeBaseIds: [base] } }))} WHERE id=${agent}`;
  const noFile = await send(`/agents/${agent}/chat`, {
    message: "Read meeting notes",
  });
  assert.equal(
    frames(noFile.body).find((f) => f.event === "error")!.data.code,
    "NO_RELEVANT_SOURCES",
  );
  const uploaded = await send(`/agents/${agent}/chat`, {
    message: "Read meeting notes",
    attachments: [doc],
  });
  assert(
    frames(uploaded.body).some((f) => f.event === "done"),
    uploaded.body,
  );
});
after(async () => {
  for (const table of [
    "handoff_events",
    "messages",
    "agent_runs",
    "conversations",
    "deployments",
    "agent_versions",
    "agents",
    "knowledge_bases",
    "embedding_models",
    "model_configurations",
    "audit_events",
    "memberships",
    "workspaces",
  ])
    await sql.unsafe(
      `DELETE FROM ${table} WHERE ${table === "workspaces" ? "id" : "workspace_id"}=$1`,
      [workspace],
    );
  await sql`DELETE FROM memberships WHERE user_id=${owner}`;
  await sql`DELETE FROM sessions WHERE user_id=${owner}`;
  await sql`DELETE FROM organizations WHERE id=${org}`;
  await sql`DELETE FROM users WHERE id=${owner}`;
  await app.close();
});
