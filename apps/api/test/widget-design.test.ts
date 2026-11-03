import { test } from "node:test";
import assert from "node:assert/strict";
import { customerAppearance } from "@agentconnect/schemas/customer-theme";
import { widgetBundle } from "../src/widget-bundle.js";
test("Customer colors override the base theme and derive legible header and message colors", () => {
  const bright = customerAppearance(
    {
      primaryColor: "#b3ff70",
      backgroundColor: "#ffffff",
      textColor: "#151515",
    },
    "dark",
  );
  assert.equal(bright.background, "#ffffff");
  assert.equal(bright.text, "#151515");
  assert.equal(bright.onPrimary, "#000000");
  assert.equal(bright.scheme, "light");
  const red = customerAppearance({
    primaryColor: "#ed0039",
    backgroundColor: "#ffffff",
    textColor: "#151515",
  });
  assert.equal(red.onPrimary, "#ffffff");
  const dark = customerAppearance(
    { backgroundColor: "#172033", textColor: "#f6f7fc" },
    "light",
  );
  assert.equal(dark.background, "#172033");
  assert.equal(dark.text, "#f6f7fc");
  assert.equal(dark.scheme, "dark");
  const fallback = customerAppearance(
    { backgroundColor: "#ffffff", textColor: "#182033" },
    "dark",
  );
  assert.equal(fallback.background, "#121620");
  assert.equal(fallback.text, "#eef0fa");
});
test("Production widget is valid standalone JavaScript with no platform logo, theme override or nested hosted iframe", () => {
  assert.doesNotThrow(() => new Function(widgetBundle));
  for (const removed of [
    "Agent Connex",
    "productBrandLogo",
    "themeToggle",
    "agent-connex-widget-theme",
    "/brand/agent-connex",
    "createElement('iframe')",
  ])
    assert.ok(!widgetBundle.includes(removed), removed);
  assert.match(widgetBundle, /chat-window/);
  assert.match(widgetBundle, /Chat options/);
  assert.match(widgetBundle, /chat-composer/);
});
