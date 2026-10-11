import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  splitting: false,
  // API helpers include CommonJS libraries that require Node built-ins.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  external: [
    "@temporalio/client",
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
    "@agentconnect/api",
    "@agentconnect/rag",
    "@agentconnect/provider-sdk",
    "@agentconnect/db",
    "@agentconnect/schemas",
  ],
  sourcemap: true,
  clean: true,
});
