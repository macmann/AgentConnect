import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/server.ts", "src/migrate.ts", "src/deployment-check.ts"],
  format: ["esm"],
  splitting: false,
  external: [
    "@langchain/langgraph",
    "@langchain/langgraph-checkpoint-postgres",
    "@modelcontextprotocol/sdk",
    "ajv",
    "undici",
    "cheerio",
    "fflate",
    "fast-xml-parser",
    "csv-parse",
    "pdfjs-dist/legacy/build/pdf.mjs",
  ],
  noExternal: [
    "@agentconnect/schemas",
    "@agentconnect/rag",
    "@agentconnect/db",
    "@agentconnect/provider-sdk",
    "@agentconnect/agent-sdk",
  ],
  sourcemap: true,
  clean: true,
});
