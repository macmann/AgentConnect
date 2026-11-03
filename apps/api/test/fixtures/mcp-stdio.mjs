import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const m = JSON.parse(line);
  if (m.id === undefined) continue;
  const result =
    m.method === "initialize"
      ? {
          protocolVersion: m.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "stdio-fixture", version: "1" },
        }
      : m.method === "tools/list"
        ? {
            tools: [
              {
                name: "inspect",
                description: "Inspect fixture environment",
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
                annotations: { readOnlyHint: true },
              },
            ],
          }
        : m.method === "tools/call"
          ? {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    authenticated:
                      process.env.FIXTURE_API_KEY === "private-test-key",
                    credential: process.env.FIXTURE_API_KEY,
                    noDatabase: !process.env.DATABASE_URL,
                    noMasterKey: !process.env.MASTER_KEY,
                  }),
                },
              ],
            }
          : {};
  console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
}
