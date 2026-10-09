import { config } from "./config.js";
import { sql } from "./db.js";
import { decrypt } from "./security.js";
if (config.NODE_ENV === "production")
  throw new Error("Local mail inspection is disabled in production");
const email = process.argv[2];
if (!email) throw new Error("Provide the exact recipient email");
try {
  const rows =
    await sql`SELECT id,subject,encrypted_body FROM mail_outbox WHERE recipient=${email} AND sent_at IS NULL ORDER BY created_at DESC LIMIT 5`;
  for (const row of rows)
    console.log(row.subject + "\n" + decrypt(row.encrypted_body, row.id));
} finally {
  await sql.end();
}
