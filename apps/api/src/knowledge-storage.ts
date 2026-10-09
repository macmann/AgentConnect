import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { config } from "./config.js";
import { KnowledgeError } from "@agentconnect/rag/parsers";
const storage = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
});
export async function storeKnowledge(key: string, bytes: Uint8Array) {
  if (bytes.byteLength > 10000000) throw new KnowledgeError("UPLOAD_LIMIT");
  await storage.send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      Body: bytes,
      ContentType: "application/octet-stream",
    }),
  );
}
export async function readKnowledge(key: string, signal: AbortSignal) {
  const result = await storage.send(
    new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
    { abortSignal: signal },
  );
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!result.Body) throw new KnowledgeError("SOURCE_MISSING");
  for await (const part of result.Body as AsyncIterable<Uint8Array>) {
    size += part.byteLength;
    if (size > 10000000) throw new KnowledgeError("UPLOAD_LIMIT");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}
export async function deleteKnowledge(key: string) {
  await storage.send(
    new DeleteObjectCommand({ Bucket: config.S3_BUCKET, Key: key }),
  );
}

export async function purgeKnowledgePrefix(prefix: string) {
  if (
    !/^[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/$/.test(
      prefix,
    )
  )
    throw new KnowledgeError("INVALID_STORAGE_PREFIX");
  for (;;) {
    const listed = await storage.send(
      new ListObjectsV2Command({
        Bucket: config.S3_BUCKET,
        Prefix: prefix,
        MaxKeys: 1000,
      }),
    );
    const objects = (listed.Contents ?? [])
      .filter((v) => v.Key)
      .map((v) => ({ Key: v.Key! }));
    if (!objects.length) break;
    const deleted = await storage.send(
      new DeleteObjectsCommand({
        Bucket: config.S3_BUCKET,
        Delete: { Objects: objects, Quiet: true },
      }),
    );
    if (deleted.Errors?.length)
      throw new KnowledgeError("OBJECT_PURGE_FAILED", true);
  }
}
