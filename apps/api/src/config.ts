import { z } from "zod";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  WEB_ORIGIN: z.url(),
  MONITORING_TOKEN: z.string().min(32).max(256).optional(),
  WORKER_HEALTH_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("127.0.0.1"),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  WORKER_STALL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MASTER_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  S3_ENDPOINT: z.url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(8),
  S3_BUCKET: z.string().min(3),
  TEMPORAL_ADDRESS: z.string().min(1),
  SMTP_URL: z.url().optional(),
  REQUIRE_EMAIL_VERIFICATION: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  MODEL_ALLOWED_HOSTS: z
    .string()
    .default(
      "api.openai.com,api.anthropic.com,generativelanguage.googleapis.com",
    ),
  MODEL_PRIVATE_HOSTS: z.string().default(""),
  WEBHOOK_ALLOWED_HOSTS: z.string().default(""),
  CONNECTOR_ALLOWED_HOSTS: z.string().default(""),
  CONNECTOR_PRIVATE_HOSTS: z.string().default(""),
  TOOL_ALLOWED_HOSTS: z.string().default(""),
  TOOL_PRIVATE_HOSTS: z.string().default(""),
  TOOL_DATABASE_HOSTS: z.string().default(""),
  KNOWLEDGE_ALLOWED_HOSTS: z.string().default(""),
  KNOWLEDGE_PRIVATE_HOSTS: z.string().default(""),
  MAIL_FROM: z.email().default("noreply@agentconnect.local"),
});
export const config = schema.parse(process.env);
if (config.NODE_ENV === "production" && !config.REQUIRE_EMAIL_VERIFICATION)
  throw new Error("Production requires email verification");
if (
  config.NODE_ENV === "production" &&
  (!config.SMTP_URL || !config.WEB_ORIGIN.startsWith("https://"))
)
  throw new Error("Production requires SMTP_URL and HTTPS WEB_ORIGIN");
