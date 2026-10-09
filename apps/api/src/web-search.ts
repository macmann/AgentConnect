import { ToolError } from "./tool-errors.js";
export interface SearchResult {
  url: string;
  title: string;
  description: string;
}
export interface SearchPolicy {
  resultCount: number;
  allowedDomains: string[];
  deniedDomains: string[];
}
export interface WebSearchAdapter {
  search(
    query: string,
    key: string,
    policy: SearchPolicy,
    signal: AbortSignal,
  ): Promise<SearchResult[]>;
}
export type SearchTransport = (
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<{ status: number; text: string }>;
export function createBraveSearchAdapter(
  request: SearchTransport,
): WebSearchAdapter {
  return {
    async search(query, key, policy, signal) {
      if (!key) throw new ToolError("TOOL_CREDENTIAL_UNAVAILABLE");
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(policy.resultCount));
      url.searchParams.set("safesearch", "strict");
      const response = await request(
        url.href,
        { Accept: "application/json", "X-Subscription-Token": key },
        signal,
      );
      if (response.status !== 200) throw new ToolError("SEARCH_PROVIDER_ERROR");
      let items: unknown;
      try {
        items = JSON.parse(response.text).web?.results ?? [];
      } catch {
        throw new ToolError("SEARCH_RESPONSE_INVALID");
      }
      if (!Array.isArray(items)) throw new ToolError("SEARCH_RESPONSE_INVALID");
      const results: SearchResult[] = [];
      for (const item of items.slice(0, 100)) {
        if (
          !item ||
          typeof item.url !== "string" ||
          typeof item.title !== "string" ||
          typeof item.description !== "string"
        )
          continue;
        try {
          const u = new URL(item.url);
          if (
            !["https:", "http:"].includes(u.protocol) ||
            u.username ||
            u.password ||
            policy.deniedDomains.includes(u.hostname) ||
            (policy.allowedDomains.length &&
              !policy.allowedDomains.includes(u.hostname))
          )
            continue;
        } catch {
          continue;
        }
        results.push({
          url: item.url,
          title: item.title,
          description: item.description,
        });
        if (results.length >= policy.resultCount) break;
      }
      return results;
    },
  };
}
