# Workflow inputs, API invocation and schedules

Workflows share one durable execution engine for canvas tests, API calls, customer quick actions and schedules. External triggers run published versions; editing a draft does not change an existing run or schedule.

## Define workflow inputs

Select the **Input** node on the Build canvas and use **Workflow inputs → Add input field**. Each field has a unique name, display label, type, required flag and optional default.

Supported types are text, number, boolean and JSON data. Names start with a letter and use letters, numbers or underscores, up to 64 characters. Up to 30 fields are supported. Defaults must match their type. Unknown fields, incorrect types and missing required values are rejected. Total serialized input is limited to 12,000 characters.

Save the draft to test it. Publish a version before using its input definition through an API or schedule. The test panel generates input controls from the selected draft or published version. Typed Input nodes output an object; downstream agents receive its JSON representation through existing data mapping. Field-level mapping is a separate future enhancement.

Workflows without input fields continue to accept text. Existing published versions retain their original behavior. Customer quick actions still use their configured forms; map their field names and types to the published workflow inputs. Quick-action forms currently support scalar values, not arbitrary JSON editors.

## Invoke a workflow from your server

1. Open **Operations → API keys**.
2. Select **Workflow execution (REST)** and the workflow.
3. Choose an expiry and enable execution details only if the caller needs node inputs/outputs, citations and tool results.
4. Copy the key once and store it on your server.

Keys authorize one workflow, inherit the issuer's current execute permission and can be revoked. Cookies do not authorize the integration endpoints. Workflow keys use REST; agent and knowledge MCP tools are unchanged.

Discover the resource and its published input definitions:

```http
GET /api/v1/resources
Authorization: Bearer <workflow-key>
```

Queue a run:

```http
POST /api/v1/workflows/<workflow-id>/runs
Authorization: Bearer <workflow-key>
Idempotency-Key: order-review-123
Content-Type: application/json

{
  "versionId": "<published-version-uuid>",
  "input": {
    "question": "Review this enquiry",
    "count": 3,
    "enabled": true
  }
}
```

Replace the input names with those declared by your workflow. For a legacy workflow, supply `"input": "Your text"`. Omitting `versionId` chooses the latest published version at first submission; specifying it makes the version choice explicit.

The API returns `202` with `{ "id": "<run-id>", "status": "queued" }` and a `Location` header. Poll:

```http
GET /api/v1/workflows/<workflow-id>/runs/<run-id>
Authorization: Bearer <same-workflow-key>
```

The response contains status, selected version, timestamps, final output and a safe error code. Append `?includeDetails=true` for recorded node and tool details when the key allows it. Runs are bound to the issuing key; another key for the same workflow cannot read them.

The `Idempotency-Key` header is required (1–128 letters, numbers, periods, underscores, colons or hyphens). Retrying the same request with that key returns the original run. Object property order does not matter. Reusing the key with different input or a different version selection returns `409`. Deduplication is scoped to the API key and lasts while the run record exists. A retry without `versionId` continues to return its original run after a newer version is published.

The API uses existing integration rate limits and the workspace limit of 20 active runs, including approval waits. A full workspace returns `429`; retry later with the same idempotency key. Invalid input returns `400`; expired/revoked keys return `401`; insufficient permission or scope returns `403`. Publish a version before calling.

Key expiry/revocation and issuer execute permission are rechecked before each workflow node. An already active provider call is not retroactively undone. Human approvals are handled in the staff workflow interface; the integration can poll the waiting status.

## Schedule a workflow

Open a saved workflow's **Triggers** activity. Publish a version if none exists, then:

1. Name the schedule and select a published version.
2. Choose **Daily**, **Weekly** or **Custom cron**.
3. Set an IANA timezone, for example `Asia/Yangon` or `America/New_York`.
4. Select **Preview next runs** to inspect the next five occurrences in that timezone.
5. Fill the version's inputs and choose overlap and downtime behavior.
6. Create the schedule.

Custom schedules use five fields: minute, hour, day of month, month and day of week. For example, `0 8 * * 1-5` runs at 08:00 on weekdays; `*/15 * * * *` runs every 15 minutes. Timezone and daylight-saving transitions are interpreted by `cron-parser`. Preview schedules around local clock changes when timing matters.

| Policy             | Behavior                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| Overlap: skip      | Skip an occurrence while this schedule has a queued, running or approval-waiting run.               |
| Overlap: allow     | Queue another run, subject to the workspace active-run limit.                                       |
| Downtime: skip     | Skip an occurrence more than one minute late.                                                       |
| Downtime: run once | Queue one catch-up run, then advance to the next future occurrence; never replay an entire backlog. |

Schedules pin their published version until explicitly edited. They support up to 20 schedules per workflow. **Pause** prevents new scheduled runs; existing runs continue and can be cancelled in the usual run inspector. Edit a paused schedule and enable it to resume. Saving or resuming recalculates its next occurrence from the current time rather than replaying its paused interval. Edits use revision checks; reload if another editor changed the schedule. The user saving a schedule becomes its execution principal.

The schedule list shows the next occurrence, last processed occurrence and last scheduling error. Run history labels scheduled and API-triggered runs. `last_run_at` represents an evaluated occurrence, including skipped occurrences; inspect run history to confirm execution. Schedule times are enqueue targets, not guaranteed completion times.

## Operation and troubleshooting

Run `pnpm db:migrate` through migration **0041**, then restart API, worker and web (or rebuild/deploy matching images). No new environment key or separate cron service is required. The worker's `workflow_schedule` health task processes due schedules using PostgreSQL locks and a unique occurrence constraint. Enqueueing and advancing the schedule commit together; a transaction failure rolls back both.

| Status/error                     | Action                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| No scheduled runs                | Check that the schedule is enabled, its workflow is not archived, and the worker is healthy.                      |
| `MISSED_OCCURRENCE_SKIPPED`      | The skip-after-downtime policy applied. Change to run once if catch-up is desired.                                |
| `OVERLAP_SKIPPED`                | Finish/cancel the previous run or explicitly allow overlap.                                                       |
| `WORKSPACE_QUOTA_SKIPPED`        | The workspace had 20 active runs. This occurrence is skipped; no backlog is added.                                |
| `SCHEDULE_ACCESS_REVOKED`        | The execution principal lost access or verification. An authorized editor must review and re-enable the schedule. |
| `SCHEDULE_CONFIGURATION_INVALID` | A dependency or input is unavailable/invalid. Fix it and save/re-enable the schedule.                             |
| `WORKFLOW_KEY_REVOKED`           | A queued API run's key expired or was revoked before a step executed.                                             |

Dependency/access failures disable a schedule to avoid repeated unattended failures. Transient database failures leave the occurrence due for worker retry. Permission is checked at scheduling and again before execution steps. Archiving a workflow prevents future scheduling and uses existing active-run cancellation.

Occurrence deduplication prevents duplicate queue entries, not exactly-once provider execution: existing checkpoint recovery can repeat an unfinished read or model call. Workflow tools remain read-only. These triggers do not add outgoing notifications, mutating actions or inbound webhook handling.
