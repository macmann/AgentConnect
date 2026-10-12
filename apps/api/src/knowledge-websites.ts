import {
  safeHttpTransport,
  validateEndpoint,
} from "@agentconnect/provider-sdk";
import {
  parseHTML,
  KnowledgeError,
  type ParsedDocument,
} from "@agentconnect/rag/parsers";
import { config } from "./config.js";
import { hosts } from "./knowledge-core.js";
export interface CrawlConfig {
  url: string;
  crawler?: "builtin" | "firecrawl";
  secretId?: string | null;
  maxPages: number;
  maxDepth: number;
  allowedPaths: string[];
  blockedPaths: string[];
}
function safeURL(url: string) {
  const u = new URL(url);
  validateEndpoint(
    `${u.origin}${u.pathname}`,
    hosts(config.KNOWLEDGE_ALLOWED_HOSTS),
    hosts(config.KNOWLEDGE_PRIVATE_HOSTS),
  );
  if (u.username || u.password) throw new KnowledgeError("INVALID_WEBSITE_URL");
  u.hash = "";
  return u;
}
export function validateWebsite(url: string) {
  return safeURL(url);
}
export async function fetchWebsite(
  url: string,
  signal: AbortSignal,
  robots = false,
) {
  return (await fetchWebsitePage(url, signal, robots)).bytes;
}

export async function fetchWebsitePage(
  url: string,
  signal: AbortSignal,
  robots = false,
  checkAccess?: (url: URL) => void,
) {
  let current = safeURL(url);
  const origin = current.origin,
    seen = new Set<string>();
  for (let hops = 0; hops <= 5; hops++) {
    signal.throwIfAborted();
    if (seen.has(current.href))
      throw new KnowledgeError("WEBSITE_REDIRECT_LIMIT");
    seen.add(current.href);
    checkAccess?.(current);
    const response = await safeHttpTransport(
      hosts(config.KNOWLEDGE_ALLOWED_HOSTS),
      hosts(config.KNOWLEDGE_PRIVATE_HOSTS),
    )(
      current.href,
      {
        accept: robots ? "text/plain" : "text/html,application/xhtml+xml",
        "user-agent": "AgentConnectKnowledge/1.0",
      },
      undefined,
      signal,
      "GET",
    );
    try {
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers?.location;
        if (typeof location !== "string" || !location)
          throw new KnowledgeError("WEBSITE_REDIRECT_BLOCKED");
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new KnowledgeError("WEBSITE_REDIRECT_BLOCKED");
        }
        if (next.origin !== origin || next.username || next.password)
          throw new KnowledgeError("WEBSITE_REDIRECT_BLOCKED");
        if (hops === 5) throw new KnowledgeError("WEBSITE_REDIRECT_LIMIT");
        // Recheck exact grants here and pin/check DNS again in the transport at every hop.
        current = safeURL(next.href);
        continue;
      }
      if (robots && response.status === 404)
        return { bytes: new Uint8Array(), url: current.href };
      if (response.status < 200 || response.status >= 300)
        throw new KnowledgeError(
          response.status >= 300 && response.status < 400
            ? "WEBSITE_REDIRECT_BLOCKED"
            : "WEBSITE_HTTP_ERROR",
          response.status === 429 || response.status >= 500,
        );
      if (
        !robots &&
        !/text\/html|application\/xhtml\+xml/i.test(
          String(response.headers?.["content-type"] ?? ""),
        )
      )
        throw new KnowledgeError("WEBSITE_CONTENT_TYPE");
      const result: Uint8Array[] = [];
      let size = 0;
      for await (const bytes of response.body) {
        signal.throwIfAborted();
        size += bytes.byteLength;
        if (size > (robots ? 500000 : 2000000))
          throw new KnowledgeError("WEBSITE_SIZE_LIMIT");
        result.push(bytes);
      }
      return { bytes: Buffer.concat(result), url: current.href };
    } finally {
      await response.close();
    }
  }
  throw new KnowledgeError("WEBSITE_REDIRECT_LIMIT");
}
export function robotsAllowed(text: string, path: string) {
  const groups: {
    agents: string[];
    rules: { allow: boolean; pattern: string }[];
  }[] = [];
  let group:
    | { agents: string[]; rules: { allow: boolean; pattern: string }[] }
    | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0]!.trim();
    const split = line.indexOf(":");
    if (split < 0) continue;
    const key = line.slice(0, split).toLowerCase(),
      value = line.slice(split + 1).trim();
    if (key === "user-agent") {
      if (!group || group.rules.length) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group && ["allow", "disallow"].includes(key) && value)
      group.rules.push({ allow: key === "allow", pattern: value });
  }
  const specific = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && "agentconnectknowledge".startsWith(a)),
  );
  const selected = specific.length
    ? specific
    : groups.filter((g) => g.agents.includes("*"));
  const matches = selected
    .flatMap((g) => g.rules)
    .filter((r) => {
      const escaped = r.pattern
        .replace(/[.+?^{}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\$$/, "$");
      return new RegExp("^" + escaped).test(path);
    })
    .sort(
      (a, b) =>
        b.pattern.replace(/\*/g, "").length -
          a.pattern.replace(/\*/g, "").length ||
        Number(b.allow) - Number(a.allow),
    );
  return matches[0]?.allow ?? true;
}
export async function crawlWebsite(
  options: CrawlConfig,
  signal: AbortSignal,
): Promise<{ document: ParsedDocument; url: string; bytes: Uint8Array }[]> {
  const root = safeURL(options.url);
  const robots = new TextDecoder().decode(
    await fetchWebsite(root.origin + "/robots.txt", signal, true),
  );
  const queue = [{ url: root.href, depth: 0 }],
    seen = new Set<string>();
  const pages: { document: ParsedDocument; url: string; bytes: Uint8Array }[] =
    [];
  let totalBytes = 0;
  const canonicalSeen = new Set<string>();
  while (queue.length && pages.length < options.maxPages) {
    signal.throwIfAborted();
    const item = queue.shift()!;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    const u = safeURL(item.url);
    if (
      u.origin !== root.origin ||
      !options.allowedPaths.some((p) => u.pathname.startsWith(p)) ||
      options.blockedPaths.some((p) => u.pathname.startsWith(p))
    )
      continue;
    if (!robotsAllowed(robots, u.pathname + u.search)) {
      if (item.depth === 0) throw new KnowledgeError("ROBOTS_DISALLOWED");
      continue;
    }
    const fetched = await fetchWebsitePage(u.href, signal, false, (target) => {
      if (
        !options.allowedPaths.some((p) => target.pathname.startsWith(p)) ||
        options.blockedPaths.some((p) => target.pathname.startsWith(p))
      )
        throw new KnowledgeError("WEBSITE_PATH_BLOCKED");
      if (!robotsAllowed(robots, target.pathname + target.search))
        throw new KnowledgeError("ROBOTS_DISALLOWED");
    });
    const bytes = fetched.bytes,
      finalURL = new URL(fetched.url);
    seen.add(finalURL.href);
    totalBytes += bytes.length;
    if (totalBytes > 20000000) throw new KnowledgeError("WEBSITE_SIZE_LIMIT");
    const document = parseHTML(bytes, finalURL.href);
    if (finalURL.href !== u.href) document.metadata.redirectedFrom = u.href;
    const canonical = document.metadata.canonical;
    let url = finalURL.href;
    if (typeof canonical === "string") {
      try {
        const proposed = new URL(canonical, finalURL);
        if (
          proposed.origin === root.origin &&
          !proposed.username &&
          !proposed.password &&
          options.allowedPaths.some((path) =>
            proposed.pathname.startsWith(path),
          ) &&
          !options.blockedPaths.some((path) =>
            proposed.pathname.startsWith(path),
          )
        ) {
          proposed.hash = "";
          url = proposed.href;
        }
      } catch {
        /* invalid canonical ignored */
      }
    }
    if (!canonicalSeen.has(url)) {
      canonicalSeen.add(url);
      pages.push({ document, url, bytes });
    }
    if (item.depth < options.maxDepth)
      for (const href of document.links) {
        try {
          const link = new URL(href, finalURL);
          link.hash = "";
          if (
            link.origin === root.origin &&
            /^https?:$/.test(link.protocol) &&
            !link.username &&
            !link.password &&
            !seen.has(link.href) &&
            queue.length < 100
          )
            queue.push({ url: link.href, depth: item.depth + 1 });
        } catch {
          /* non-URL links ignored */
        }
      }
  }
  if (!pages.length) throw new KnowledgeError("NO_WEBSITE_PAGES");
  return pages;
}
