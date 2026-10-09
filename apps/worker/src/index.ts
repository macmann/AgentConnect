import {
  processWorkflowRun,
  closeWorkflowSaver,
} from "@agentconnect/api/workflows";
import { deliverMail } from "@agentconnect/api/mail";
import {
  processKnowledgeJob,
  purgeDeletedKnowledge,
} from "@agentconnect/api/ingestion";
import { config } from "@agentconnect/api/config";
if (!config.SMTP_URL) throw new Error("Mail worker requires SMTP_URL");
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
  });
async function loop(
  task: () => Promise<unknown>,
  delay: number,
  label: string,
) {
  while (!stopping) {
    try {
      await task();
    } catch {
      console.error(label + " failed; durable jobs retained");
    }
    if (!stopping) await new Promise((r) => setTimeout(r, delay));
  }
}
await Promise.all([
  loop(processWorkflowRun, 1000, "Workflow execution"),
  loop(deliverMail, 3000, "Mail delivery"),
  loop(processKnowledgeJob, 1000, "Knowledge ingestion"),
  loop(purgeDeletedKnowledge, 5000, "Knowledge object cleanup"),
]);
await closeWorkflowSaver();
process.exit(0);
