import {
  WorkerProgress,
  type WorkerTaskName,
} from "@agentconnect/api/monitoring-core";
import { workerHealth } from "./health.js";
import { processSupportTriage } from "@agentconnect/api/support-triage";
import {
  processSupportRouting,
  processSupportOperations,
} from "@agentconnect/api/support";
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
const progress = new WorkerProgress(config.WORKER_STALL_SECONDS);
const health = workerHealth(progress, config.MONITORING_TOKEN);
await new Promise<void>((resolve, reject) => {
  health.once("error", reject);
  health.listen(config.WORKER_HEALTH_PORT, config.WORKER_HEALTH_HOST, resolve);
});
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    progress.stopping = true;
    health.close();
  });
async function loop(
  task: () => Promise<unknown>,
  delay: number,
  label: string,
  name: WorkerTaskName,
) {
  let failures = 0;
  while (!stopping) {
    const started = Date.now();
    try {
      await task();
      failures = 0;
      progress.complete(name, true, Date.now() - started);
    } catch (error) {
      failures++;
      progress.complete(name, false, Date.now() - started);
      console.error(workerFailure(error, label));
    }
    if (!stopping)
      await new Promise((r) =>
        setTimeout(r, Math.min(30000, delay * 2 ** Math.min(failures, 5))),
      );
  }
}
await Promise.all([
  loop(processSupportTriage, 1000, "Support triage", "support_triage"),
  loop(
    processSupportOperations,
    1000,
    "Support SLA and assignment expiry",
    "support_operations",
  ),
  loop(processSupportRouting, 3000, "Support routing", "support_routing"),
  loop(
    processRetentionCleanup,
    5000,
    "Workspace retention cleanup",
    "retention_cleanup",
  ),
  loop(
    processRetentionObjectDeletion,
    1000,
    "Retention object deletion",
    "retention_objects",
  ),
  loop(
    processConnectorSync,
    3000,
    "Enterprise connector sync",
    "connector_sync",
  ),
  loop(processEvaluationRun, 1000, "Quality evaluation", "evaluation"),
  loop(processWorkflowRun, 1000, "Workflow execution", "workflow"),
  loop(deliverMail, 3000, "Mail delivery", "mail"),
  loop(processWebhookDelivery, 1000, "Webhook delivery", "webhook"),
  loop(processKnowledgeJob, 1000, "Knowledge ingestion", "knowledge"),
  loop(
    purgeDeletedKnowledge,
    5000,
    "Knowledge object cleanup",
    "knowledge_cleanup",
  ),
]);
await closeWorkflowSaver();
process.exit(0);
