import { test, expect } from "@playwright/test";
import { createServer } from "node:http";

const text =
  '# Study guide\n\n**Bold** and *italic* with ~~removed~~ and `inline`.\n\n- First\n- Second\n\n1. One\n2. Two\n\n> Helpful quote\n\n```js\nconst value = "<safe>";\n```\n\n| Topic | Status |\n| --- | --- |\n| Markdown | Ready |\n\n[Documentation](https://example.com/docs)\n\n[Unsafe](javascript:alert(1))\n\n<script>window.__unsafe = true</script><img src=x onerror="window.__unsafe=true"><svg onload="window.__unsafe=true"></svg>';

test("Widget renders safe Markdown during streaming, in rich text and after history restore", async ({
  page,
}) => {
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error(error.message);
  });
  const site = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(
      '<html><body><script src="http://localhost:4000/widget.js" data-deployment="00000000-0000-4000-8000-000000000001"></script></body></html>',
    );
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  let rich = false;
  const messages = [];
  await page.route("http://localhost:4000/public/widgets/**", (route) => {
    const url = new URL(route.request().url());
    let body = {};
    if (url.pathname.endsWith("/chat")) {
      messages.push({
        role: "assistant",
        content: text,
        messageId: "answer",
        created_at: new Date().toISOString(),
      });
      const event = (type, data) =>
        `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      const stream =
        event("meta", { conversationId: "saved", guestToken: "fixture" }) +
        (rich
          ? event("ui", {
              message: "**Rich intro**",
              blocks: [
                { type: "text", content: "## Rich heading\n\n- Rich item" },
              ],
            })
          : event("token", { text: text.slice(0, 26) }) +
            event("token", { text: text.slice(26) })) +
        event("done", { messageId: "answer" });
      return route.fulfill({
        contentType: "text/event-stream",
        headers: { "access-control-allow-origin": "*" },
        body: stream,
      });
    }
    if (url.pathname.endsWith("/sessions"))
      body = {
        token: "fixture",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      };
    else if (url.pathname.endsWith("/history/saved"))
      body = { messages, hasMore: false };
    else if (url.pathname.endsWith("/history")) body = [];
    else if (url.pathname.includes("/handoff"))
      body = {
        status: "none",
        conversationMode: "ai",
        events: [],
        access: { canRequest: false },
      };
    else if (url.pathname.endsWith("00000000-0000-4000-8000-000000000001"))
      body = {
        name: "Study assistant",
        welcomeMessage: "Welcome",
        branding: {},
        widget: {
          theme: "light",
          width: 420,
          height: 640,
          launcher: "Chat",
          position: "right",
          language: "en",
        },
      };
    return route.fulfill({
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify(body),
    });
  });
  try {
    await page.goto("http://localhost:" + site.address().port);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.getByLabel("Message", { exact: true }).fill("Explain markdown");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const check = async () => {
      await expect(
        page.getByRole("heading", { name: "Study guide", exact: true }),
      ).toBeVisible();
      await expect(page.locator(".message-bubble strong")).toHaveText("Bold");
      await expect(page.locator(".message-bubble em")).toHaveText("italic");
      await expect(page.locator(".message-bubble del")).toHaveText("removed");
      await expect(page.locator(".message-bubble ul li")).toHaveCount(2);
      await expect(page.locator(".message-bubble ol li")).toHaveCount(2);
      await expect(page.locator(".message-bubble pre code")).toHaveText(
        'const value = "<safe>";\n',
      );
      await expect(
        page.getByRole("cell", { name: "Ready", exact: true }),
      ).toHaveCount(1);
      await expect(
        page.getByRole("link", { name: "Documentation", exact: true }),
      ).toHaveAttribute("rel", "noopener noreferrer");
      await expect(
        page.locator(".message-bubble a").filter({ hasText: "Unsafe" }),
      ).not.toHaveAttribute("href", /./);
      await expect(
        page.locator(
          ".message-bubble script,.message-bubble img,.message-bubble svg",
        ),
      ).toHaveCount(0);
      expect(await page.evaluate(() => window.__unsafe)).toBeUndefined();
    };
    await check();
    await page.reload();
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await check();
    rich = true;
    await page
      .getByLabel("Message", { exact: true })
      .fill("Show rich response");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Rich heading", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".rich-block li")).toHaveText("Rich item");
    await expect(
      page.locator("strong").filter({ hasText: "Rich intro" }),
    ).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    site.closeAllConnections();
    await new Promise((resolve) => site.close(resolve));
  }
});
