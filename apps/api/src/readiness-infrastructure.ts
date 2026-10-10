import postgres from "postgres";
import { Redis } from "ioredis";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { Connection } from "@temporalio/client";
import { config } from "./config.js";
import { createReadinessProbe, type ReadinessChecks } from "./readiness.js";
import {
  requiredMigrations,
  supportedVectorVersion,
} from "./release-requirements.js";
export function infrastructureReadiness() {
  // Separate bounded pool: operational probes cannot consume the request pool.
  const db = postgres(config.DATABASE_URL, {
    max: 1,
    connect_timeout: 2,
    idle_timeout: 2,
    connection: {
      statement_timeout: 2000,
      application_name: "agentconnect-readiness",
    },
  });
  const checks: ReadinessChecks = {
    async postgres(signal) {
      signal.throwIfAborted();
      const query = db`SELECT (SELECT extversion FROM pg_extension WHERE extname='vector') AS vector, ARRAY(SELECT version FROM schema_migrations) AS migrations`;
      const cancel = () => query.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const [row] = await query;
        if (
          !supportedVectorVersion(row?.vector) ||
          !requiredMigrations.every((v) => row?.migrations.includes(v))
        )
          throw new Error("Schema unavailable");
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
    async redis(signal) {
      const redis = new Redis(config.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        connectTimeout: 2000,
        commandTimeout: 2000,
        retryStrategy: () => null,
      });
      redis.on("error", () => {});
      const cancel = () => redis.disconnect();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        signal.throwIfAborted();
        await redis.ping();
      } finally {
        signal.removeEventListener("abort", cancel);
        redis.disconnect();
      }
    },
    async storage(signal) {
      const s3 = new S3Client({
        endpoint: config.S3_ENDPOINT,
        region: "us-east-1",
        forcePathStyle: true,
        maxAttempts: 1,
        credentials: {
          accessKeyId: config.S3_ACCESS_KEY,
          secretAccessKey: config.S3_SECRET_KEY,
        },
      });
      try {
        await s3.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }), {
          abortSignal: signal,
        });
      } finally {
        s3.destroy();
      }
    },
    async temporal(signal) {
      const c = await Connection.connect({
        address: config.TEMPORAL_ADDRESS,
        connectTimeout: "2s",
      });
      try {
        signal.throwIfAborted();
        await c.withDeadline(Date.now() + 2000, () =>
          c.workflowService.getSystemInfo({}),
        );
      } finally {
        await c.close();
      }
    },
  };
  return {
    probe: createReadinessProbe(checks),
    close: () => db.end({ timeout: 1 }),
  };
}
