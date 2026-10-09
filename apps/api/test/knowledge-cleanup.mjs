import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
// Removes only a uniquely generated test organization's artifacts.
export async function cleanupKnowledgeFixtures(sql, organizationId) {
  if (!/^[a-f0-9-]{36}$/.test(organizationId))
    throw new Error("Invalid fixture tenant");
  const bases =
    await sql`SELECT id FROM knowledge_bases WHERE organization_id=${organizationId}`;
  for (const base of bases) {
    if (!/^[a-f0-9-]{36}$/.test(base.id)) throw new Error("Invalid fixture KB");
    await sql.unsafe("DROP INDEX IF EXISTS kb_" + base.id.replaceAll("-", ""));
  }
  const storage = new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
  });
  try {
    for (;;) {
      const listed = await storage.send(
        new ListObjectsV2Command({
          Bucket: process.env.S3_BUCKET,
          Prefix: organizationId + "/",
          MaxKeys: 1000,
        }),
      );
      const objects = (listed.Contents ?? [])
        .filter((v) => v.Key)
        .map((v) => ({ Key: v.Key }));
      if (!objects.length) break;
      const deleted = await storage.send(
        new DeleteObjectsCommand({
          Bucket: process.env.S3_BUCKET,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
      if (deleted.Errors?.length)
        throw new Error("Fixture storage cleanup failed");
    }
  } finally {
    storage.destroy();
  }
}
