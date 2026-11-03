import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import {
  widgetPreviewDocument,
  type WidgetPresentation,
} from "../../web/components/widget-preview-document.js";
import { widgetSettings } from "@agentconnect/schemas/channels";
import { branding } from "@agentconnect/schemas/customer-experience";
const presentation: WidgetPresentation = {
  name: "</script><img src=x onerror=alert(1)>",
  welcomeMessage: "Welcome",
  conversationStarters: [],
  quickActions: [],
  widget: widgetSettings.parse({}),
  branding: branding.parse({}),
};
test("Preview embeds the production bundle and escapes draft values in an opaque sandbox document", () => {
  const doc = widgetPreviewDocument(
    "http://localhost:4000",
    "00000000-0000-4000-8000-000000000001",
    presentation,
    true,
    "http://localhost:3000",
  );
  assert.ok(doc.includes('src="http://localhost:4000/widget.js"'));
  assert.ok(doc.includes("connect-src 'none'"));
  assert.ok(!doc.includes(presentation.name));
  assert.ok(doc.includes("\\u003c/script>"));
  assert.ok(!doc.includes("allow-same-origin"));
});
test("Preview transport cannot contact the API, create real sessions or run models; sample SSE matches the widget protocol", async () => {
  const doc = widgetPreviewDocument(
    "http://localhost:4000",
    "00000000-0000-4000-8000-000000000001",
    presentation,
    true,
    "http://localhost:3000",
  );
  const script = doc.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  const frame: { fetch?: typeof fetch; addEventListener: () => void } = {
    addEventListener() {},
  };
  runInNewContext(script, {
    window: frame,
    parent: { postMessage() {} },
    document: { querySelectorAll: () => [] },
    setInterval: () => 0,
    clearInterval() {},
    Response,
    ReadableStream,
    URL,
  });
  const api =
    "http://localhost:4000/public/widgets/00000000-0000-4000-8000-000000000001";
  assert.equal(
    (await (await frame.fetch!(api)).json()).name,
    presentation.name,
  );
  assert.equal(
    (await (await frame.fetch!(api + "/sessions", { method: "POST" })).json())
      .token,
    "preview-session-only",
  );
  const chat = await frame.fetch!(api + "/chat", { method: "POST" });
  const text = await chat.text();
  assert.ok(text.startsWith("event: meta\ndata: "));
  assert.equal(text.split("\n\n").filter(Boolean).length, 3);
  assert.ok(text.includes("event: done\n"));
  assert.equal((await frame.fetch!("https://other.example/")).status, 403);
  assert.equal(
    (await frame.fetch!(api + "/conversations", { method: "POST" })).status,
    403,
  );
});
