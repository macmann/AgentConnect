import { existsSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
if (!existsSync(".env")) {
  const password = randomBytes(24).toString("hex");
  writeFileSync(
    ".env",
    `NODE_ENV=development
PORT=4000
WEB_ORIGIN=http://localhost:3000
NEXT_PUBLIC_API_URL=http://localhost:4000
POSTGRES_PASSWORD=${password}
DATABASE_URL=postgres://agentconnect:${password}@localhost:5432/agentconnect
REDIS_URL=redis://localhost:6379
MASTER_KEY=${randomBytes(32).toString("hex")}
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=agentconnect
S3_SECRET_KEY=${randomBytes(24).toString("hex")}
S3_BUCKET=agentconnect
TEMPORAL_ADDRESS=localhost:7233
SMTP_URL=smtp://127.0.0.1:1025\nMAIL_FROM=noreply@agentconnect.local
`,
    { mode: 0o600 },
  );
  console.log("Created local .env with random development credentials");
} else console.log("Existing .env preserved");
