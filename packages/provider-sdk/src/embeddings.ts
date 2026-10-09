import { ProviderError, type Transport } from "./index.js";
export interface EmbeddingConnection {
  provider: "openai" | "openai-compatible" | "gemini";
  modelId: string;
  baseUrl: string;
  apiKey?: string;
  dimensions: number;
}
export interface EmbeddingProvider {
  embed(
    texts: string[],
    signal: AbortSignal,
    task: "document" | "query",
  ): Promise<number[][]>;
}
export type EmbeddingFactory = (
  connection: EmbeddingConnection,
) => EmbeddingProvider;
export function validateVectors(
  vectors: unknown,
  count: number,
  dimensions: number,
): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count)
    throw new ProviderError("INVALID_EMBEDDING_RESPONSE");
  for (const vector of vectors)
    if (
      !Array.isArray(vector) ||
      vector.length !== dimensions ||
      vector.some((n) => typeof n !== "number" || !Number.isFinite(n)) ||
      !vector.some((n) => n !== 0)
    )
      throw new ProviderError("EMBEDDING_DIMENSION_MISMATCH");
  return vectors as number[][];
}
export function createEmbeddingProvider(
  c: EmbeddingConnection,
  transport: Transport,
): EmbeddingProvider {
  return {
    async embed(texts, signal, task) {
      if (!texts.length || texts.length > 32)
        throw new ProviderError("EMBEDDING_BATCH_LIMIT");
      if (c.provider !== "openai-compatible" && !c.apiKey)
        throw new ProviderError("MISSING_CREDENTIAL");
      let url: string, payload: unknown;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
      };
      if (c.provider === "gemini") {
        if (c.apiKey) headers["x-goog-api-key"] = c.apiKey;
        const model = "models/" + c.modelId.replace(/^models\//, "");
        url =
          c.baseUrl.replace(/\/$/, "") + "/" + model + ":batchEmbedContents";
        payload = {
          requests: texts.map((text) => ({
            model,
            content: { parts: [{ text }] },
            taskType:
              task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
            outputDimensionality: c.dimensions,
          })),
        };
      } else {
        url = c.baseUrl.replace(/\/$/, "") + "/embeddings";
        if (c.apiKey) headers.Authorization = "Bearer " + c.apiKey;
        payload = {
          model: c.modelId,
          input: texts,
          encoding_format: "float",
          ...(c.provider === "openai" &&
          c.modelId.startsWith("text-embedding-3-")
            ? { dimensions: c.dimensions }
            : {}),
        };
      }
      const response = await transport(url, headers, payload, signal);
      try {
        if (response.status < 200 || response.status >= 300)
          throw new ProviderError(
            response.status === 429
              ? "RATE_LIMITED"
              : response.status === 401 || response.status === 403
                ? "AUTHENTICATION_FAILED"
                : "EMBEDDING_HTTP_ERROR",
            response.status === 429 || response.status >= 500,
          );
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for await (const part of response.body) {
          bytes += part.byteLength;
          if (bytes > 8000000)
            throw new ProviderError("EMBEDDING_RESPONSE_LIMIT");
          chunks.push(part);
        }
        let value: Record<string, unknown>;
        try {
          value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new ProviderError("INVALID_EMBEDDING_RESPONSE");
        }
        if (c.provider === "gemini")
          return validateVectors(
            Array.isArray(value.embeddings)
              ? value.embeddings.map((e: { values?: unknown }) => e.values)
              : null,
            texts.length,
            c.dimensions,
          );
        if (!Array.isArray(value.data))
          throw new ProviderError("INVALID_EMBEDDING_RESPONSE");
        const sorted = value.data as { index: number; embedding: unknown }[];
        sorted.sort((a, b) => a.index - b.index);
        if (sorted.some((v, i) => v.index !== i))
          throw new ProviderError("INVALID_EMBEDDING_RESPONSE");
        return validateVectors(
          sorted.map((v) => v.embedding),
          texts.length,
          c.dimensions,
        );
      } finally {
        await response.close();
      }
    },
  };
}
