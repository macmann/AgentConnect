import {
  processRetentionCleanup,
  processRetentionObjectDeletion,
} from "@agentconnect/api/retention";
import { processConnectorSync } from "@agentconnect/api/connectors";
import { processEvaluationRun } from "@agentconnect/api/quality";
import { processWebhookDelivery } from "@agentconnect/api/webhooks";
import { workerFailure } from "./failure.js";
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
  let failures = 0;
  while (!stopping) {
    try {
      await task();
      failures = 0;
    } catch (error) {
      failures++;
      console.error(workerFailure(error, label));
    }
    if (!stopping)
      await new Promise((r) =>
        setTimeout(r, Math.min(30000, delay * 2 ** Math.min(failures, 5))),
      );
  }
}
await Promise.all([
  loop(processRetentionCleanup, 5000, "Workspace retention cleanup"),
  loop(processRetentionObjectDeletion, 1000, "Retention object deletion"),
  loop(processConnectorSync, 3000, "Enterprise connector sync"),
  loop(processEvaluationRun, 1000, "Quality evaluation"),
  loop(processWorkflowRun, 1000, "Workflow execution"),
  loop(deliverMail, 3000, "Mail delivery"),
  loop(processWebhookDelivery, 1000, "Webhook delivery"),
  loop(processKnowledgeJob, 1000, "Knowledge ingestion"),
  loop(purgeDeletedKnowledge, 5000, "Knowledge object cleanup"),
]);
await closeWorkflowSaver();
process.exit(0);
