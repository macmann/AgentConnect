/** Service endpoints are suggestions; normal administrator egress policy still applies. */
export const toolTemplates = [
  {
    id: "brave",
    name: "Web search",
    service: "Brave Search",
    description: "Search the web for current information.",
    kind: "search",
    url: "",
    credential: true,
  },
  {
    id: "financial",
    name: "Financial calculator",
    service: "Built in",
    description: "Calculate totals, ratios, percentages and changes.",
    kind: "financial",
    url: "",
    credential: false,
  },
  {
    id: "github",
    name: "GitHub",
    service: "MCP · HTTP",
    description: "Connect repository tools using your GitHub token.",
    kind: "mcp",
    url: "https://api.githubcopilot.com/mcp/",
    credential: true,
  },
  {
    id: "context7",
    name: "Documentation",
    service: "Context7 · MCP",
    description: "Find up-to-date library documentation.",
    kind: "mcp",
    url: "https://mcp.context7.com/mcp",
    credential: false,
  },
  {
    id: "code",
    name: "Code executor",
    service: "Your sandbox · MCP",
    description:
      "Connect a sandboxed code execution service over HTTP or STDIO.",
    kind: "mcp",
    url: "",
    credential: false,
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    service: "Read-only database",
    description: "Look up rows from an approved table or view.",
    kind: "database",
    url: "",
    credential: true,
  },
] as const;
export type ToolTemplateId = (typeof toolTemplates)[number]["id"];
