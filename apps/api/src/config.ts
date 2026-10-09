import { z } from "zod";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  WEB_ORIGIN: z.url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MASTER_KEY: z.string().regex(/^[a-f0-9]{64}$/),
  S3_ENDPOINT: z.url(),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(8),
  S3_BUCKET: z.string().min(3),
  TEMPORAL_ADDRESS: z.string().min(1),
  SMTP_URL: z.url().optional(),
  MODEL_ALLOWED_HOSTS: z
    .string()
    .default(
      "api.openai.com,api.anthropic.com,generativelanguage.googleapis.com",
    ),
  MODEL_PRIVATE_HOSTS: z.string().default(""),
  TOOL_ALLOWED_HOSTS: z.string().default(""),
  TOOL_PRIVATE_HOSTS: z.string().default(""),
  TOOL_DATABASE_HOSTS: z.string().default(""),
  KNOWLEDGE_ALLOWED_HOSTS: z.string().default(""),
  KNOWLEDGE_PRIVATE_HOSTS: z.string().default(""),
  MAIL_FROM: z.email().default("noreply@agentconnect.local"),
});
export const config = schema.parse(process.env);
if (
  config.NODE_ENV === "production" &&
  (!config.SMTP_URL || !config.WEB_ORIGIN.startsWith("https://"))
)
  throw new Error("Production requires SMTP_URL and HTTPS WEB_ORIGIN");
