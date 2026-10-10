# Workspace retention

Apply migration **0016**, restart the API and worker, then open **Retention** in the workspace menu. Existing workspaces keep everything indefinitely and automatic cleanup is disabled. Owners, organization administrators and workspace administrators can manage the policy; builders, operators and analysts can view settings and cleanup history. Viewer access and cross-workspace references are denied.

Each period accepts a whole number of days from 1 to 36,500. Leave it blank to retain indefinitely. Save the settings, preview the next batch, and enable cleanup when the periods match your organization's requirements. The first automatic batch is scheduled one day after enabling or changing an enabled policy. Manual cleanup requires an enabled saved policy and current revision; the UI requires a preview and a permanent-deletion acknowledgement. Preview reads data and returns counts without scheduling or deleting anything. It is a snapshot, not a reservation: subsequent activity can reduce eligibility.

| Period | Age and deleted data |
| --- | --- |
| Conversations | Last activity from chat runs, messages and handoff events. Removes the expired conversation, agent runs, messages, tool traces, reviews, form submissions, handoff history and generated files. |
| Runs | Completion time of terminal agent, workflow and evaluation runs. Agent runs include their messages, tool traces, reviews, forms and generated files; workflows include node traces, approvals and all LangGraph checkpoint payload tables. Evaluation results are removed with their run. Referenced evaluation baselines are protected until their dependents expire. |
| Generated files | Creation time. Removes the file registry and download authorization, leaves the message and marks the file block expired. |
| Connector history | Completion time of terminal syncs. Keeps connector settings, imported knowledge and item fingerprints, including the last-seen sync identifier used for reconciliation. |

A parent period also removes its related data, even when a child period is blank or longer. For example, deleting an expired conversation removes its attached files regardless of the generated-file period. Shortening the run period can remove messages used as future agent context, even while the conversation remains available. Removing evaluation history can make publication quality gates require a fresh evaluation.

Running agent/tool work, pending or active human handoffs, queued/running/waiting workflows and queued/running connector or evaluation jobs are excluded. Agent-history cleanup conservatively protects the entire conversation during active work or a handoff. Conversation last-activity timestamps survive removal of older runs. Writers and cleanup share conversation locks; the worker rechecks eligibility after acquiring locks. Administrator membership is locked and rechecked when queued work executes. Policy changes cancel queued work, and stale revisions or revoked access cannot apply a policy.

## Worker and deletion guarantees

The worker polls every five seconds and processes one queued database batch per invocation. At most 100 independent roots per category are selected, with all their related records. Descendants can exceed 100; preview includes their counts. Statements have a 15-second timeout and lock acquisition a two-second timeout. Large individual histories can require investigation if they repeatedly exceed these limits. When a batch reaches the limit, another automatic batch is scheduled within five minutes rather than waiting a day. Completion records contain actual deletion counts. Policy changes, manual queueing and completed cleanup are recorded in the raw audit trail; policy-change audit metadata includes the saved periods and revision.

All database deletes, checkpoint deletes, completion/audit records and generated-object deletion jobs commit together. A process crash before commit rolls back the entire batch and leaves it queued. A handled failure rolls back the batch and marks its job `CLEANUP_FAILED`; a safe terminal log includes the run ID. Investigate and queue a new batch after fixing the cause. Changing or disabling the policy cannot undo a completed deletion or stop deletion of objects whose registry rows have already been removed.

An independent worker deletes one queued generated object per second. Object calls have a five-second abort deadline. Failures retain the job and retry after 30 seconds with exponential backoff up to one hour. S3 deletion is idempotent, so a crash after storage deletion but before outbox commit is safe to replay. Download grants become unavailable as soon as the artifact registry is deleted, including previously issued application download URLs. The message's file block becomes **File expired**.

Only the exact `generated/{organization}/{workspace}/{artifact-id}` key for the deleted artifact is accepted. Invalid references roll back the database batch; invalid outbox keys are marked `blocked` without calling storage. The Retention page shows pending/blocked object counts and the last 30 cleanup jobs. Do not repair blocked keys by guessing: check the original tenant/artifact identity against trusted records. Storage failures never persist provider responses, keys or content in error fields.

## Operational limits

This policy covers the live application data listed above. Raw audit and retention job metadata, identities, credentials, model/agent/workflow definitions, knowledge sources, datasets and their imported copies, webhook payload copies, standalone tool executions, backups and external provider copies are retained. There is no legal-hold system, subject-erasure workflow or automatic cleanup of those other categories in this slice. Production compliance requires approved policies for them separately.

S3 `DeleteObject` removes the current object from application access. Versioned buckets can retain old versions and delete markers; configure approved noncurrent-version expiry or version-aware erasure separately. Production replicas and backups need their own retention policies. Database cleanup and storage deletion are intentionally asynchronous; monitor pending/blocked object jobs and persistent batch failures. These checks are not a guarantee of instant physical erasure across replicas, backups or caches.

Validation commands: `pnpm db:migrate`, `pnpm test`, `pnpm test:security`, and `pnpm test:e2e retention.spec.mjs` while the normal API/web/worker are running. Integration tests use isolated fixture tenants, real PostgreSQL and S3; the browser flow saves/previews a policy and observes a real worker completion.
