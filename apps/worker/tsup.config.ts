import { defineConfig } from "tsup";
export default defineConfig({
  entry: ["src/index.ts"],
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
    "@agentconnect/api",
    "@agentconnect/rag",
    "@agentconnect/provider-sdk",
    "@agentconnect/db",
    "@agentconnect/schemas",
  ],
  sourcemap: true,
  clean: true,
});
