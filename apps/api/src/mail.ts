import type { TransactionSql } from "postgres";
import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { sql } from "./db.js";
import { config } from "./config.js";
import { encrypt, decrypt } from "./security.js";
export async function queueMail(
  tx: TransactionSql,
  email: string,
  subject: string,
  body: string,
) {
  const mailId = randomUUID();
  await tx`INSERT INTO mail_outbox(id,recipient,subject,encrypted_body) VALUES (${mailId},${email},${subject},${tx.json(encrypt(body, mailId))})`;
}
export async function deliverMail() {
  if (!config.SMTP_URL) return;
  const transport = nodemailer.createTransport(config.SMTP_URL, {
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
    requireTLS: config.NODE_ENV === "production",
  });
  try {
    await sql.begin(async (tx) => {
      const rows =
        await tx`SELECT * FROM mail_outbox WHERE sent_at IS NULL ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED`;
      for (const m of rows) {
        await transport.sendMail({
          from: config.MAIL_FROM,
          to: m.recipient,
          subject: m.subject,
          text: decrypt(m.encrypted_body, m.id),
        });
        await tx`UPDATE mail_outbox SET sent_at=now(),encrypted_body='{}' WHERE id=${m.id}`;
      }
    });
  } finally {
    transport.close();
  }
}
