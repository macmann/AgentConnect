import { deliverMail } from "./mail.js";
import { config } from "./config.js";
if (!config.SMTP_URL)
  throw new Error("Configure SMTP_URL before starting mail worker");
for (;;) {
  try {
    await deliverMail();
  } catch {
    console.error("Mail delivery failed; queued messages retained");
  }
  await new Promise((r) => setTimeout(r, 5000));
}
