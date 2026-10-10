# Human support enrichment

The [implementation specification](human-support-spec.md) is the next product roadmap. Deployment automation and additional monitoring work are paused at the user's request. Existing readiness, recovery and retention features remain available.

## Delivery phases

| Phase | Scope                                                                                        | Status                                            |
| ----- | -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| A     | Cases, events, queues, conversation control, migration, permissions, basic APIs              | Implemented; validation recorded in validation.md |
| B     | Dedicated Human Support console, filters, unified timeline, internal notes, operator actions | Implemented; validation recorded in validation.md |
| C     | Operator profiles, presence, skills, languages, capacity and routing                         | Implemented; validation recorded in validation.md |
| D     | Escalation policy, AI triage and handoff brief                                               | Implemented; validation recorded in validation.md |
| E     | Private operator copilot                                                                     | Implemented; validation recorded in validation.md |
| F     | Structured resolution, AI continuation and flagship AI → human → AI test                     | Implemented; validation recorded in validation.md |
| G     | SLA, business hours, notifications, supervision and analytics                                | Implemented; validation recorded in validation.md |

## Phase A architecture

A conversation remains the customer journey. Each escalation creates a support case on that conversation; later escalations create additional cases. PostgreSQL enforces at most one open case per conversation. `conversation_mode` is the authoritative controller: `ai`, `waiting_human`, `human` or `returning_to_ai`. The last mode pauses chat during controlled continuation or when return to AI is disabled by policy.

The case service locks the conversation before its case. AI run creation, support actions and retention use that same conversation lock. A running AI response prevents support activation, and every mode other than `ai` blocks new autonomous responses. No model service is called to create, claim, reply to or resolve a case.

Events are durable and cannot be updated. Tenant-consistent composite foreign keys bind cases to conversations, queues and event histories. Assignment additionally requires workspace membership at the database boundary and eligible RBAC permissions in the service. Support message content remains in support events and the compatibility thread; general audit records contain action identifiers rather than message bodies. Retention protects open cases and removes support cases/events with an eligible expired conversation.

## Migration and compatibility

Run `pnpm db:migrate` to apply **0017–0021**, then restart API and worker. No additional credentials are needed. Migration 0017 preserves `handoff_events` and copies their IDs, content, actors and timestamps into the support timeline. Every legacy non-`none` handoff becomes a historical case: pending → queued, active → active, resolved → resolved. Legacy threads lack reliable case boundaries, so a migrated thread is represented by one case; new escalations have separate case IDs.

Widget, hosted-chat, playground and Channels inbox endpoints still work. Their legacy status/event fields are maintained by the same case service, rather than a second state machine. Duplicate legacy requests/claims keep returning 409 as existing clients expect. The new case API returns the existing open case for duplicate escalation and supports an optional UUID `idempotencyKey` for exact request retries. Reusing a key for a different conversation returns 409.

**Assignment is now exclusive.** An assigned operator or supervisor can reply/change status/resolve. Claim is atomic; another operator receives 409. Workspace and organization administrators have supervisor permissions. Builders and operators can view, claim, reply and resolve their cases. Analysts can read cases/queues, but cannot mutate them. Existing users, sessions and memberships are reused.

## Case state machine

Normal lifecycle: requested → triaging → queued → assigned → active → resolved → closed. Manual escalation initially creates a queued case. Claim directly accepts a queued case, whereas supervisor assignment creates an assigned case for operator acceptance through the status endpoint.

An active case can wait for the customer or an external party, then become active again or resolve. Returning an active/assigned case to queued removes its assignee. Requested/triaging/queued/assigned cases may be cancelled. A resolved case may reopen if no other open case exists; a closed case requires a new escalation. Closing an old case never changes a newer case's controller. Invalid transitions return 409.

Resolving an active case stores its code, summary and initial resume-context record and returns the same conversation to AI control. Phase F validates separate approved facts and incorporates permitted public specialist messages in subsequent AI turns.

## API usage

All new resources use `/workspaces/:workspaceId/support` and require the existing signed-in session and origin policy. Execution-only API keys and guest tokens cannot administer support cases. Public customers continue using the narrowly scoped deployment/widget handoff routes, bound to conversation token, deployment and embedding origin. They cannot supply internal queue/operator IDs or read internal support metadata.

| Method     | Resource under support    | Purpose                                        |
| ---------- | ------------------------- | ---------------------------------------------- |
| GET / POST | `/queues`                 | List / create manual queues                    |
| PATCH      | `/queues/:queueId`        | Edit or disable; historical references remain  |
| GET / POST | `/cases`                  | Filter / escalate an existing conversation     |
| GET        | `/cases/:caseId`          | Read case details                              |
| GET        | `/cases/:caseId/events`   | Read the internal timeline                     |
| POST       | `/cases/:caseId/claim`    | Atomically claim and accept                    |
| POST       | `/cases/:caseId/assign`   | Supervisor assignment                          |
| POST       | `/cases/:caseId/status`   | Accept, wait, requeue, cancel, reopen or close |
| POST       | `/cases/:caseId/messages` | Assigned operator or supervisor reply          |
| POST       | `/cases/:caseId/resolve`  | Persist resolution and restore AI control      |

The resources are discoverable in `/openapi.json` under **Human support**. JSON request examples:

```json
{
  "name": "Billing",
  "description": "Billing support",
  "routingStrategy": "manual"
}
```

```json
{
  "conversationId": "<conversation UUID>",
  "queueId": "<optional queue UUID>",
  "reasonCode": "billing",
  "reasonText": "Needs specialist review",
  "priority": "high",
  "idempotencyKey": "<optional UUID>"
}
```

```json
{ "operatorId": "<existing eligible workspace user UUID>" }
```

```json
{ "status": "active" }
```

```json
{ "content": "I have reviewed your request." }
```

```json
{ "code": "resolved", "summary": "Describe what the specialist completed." }
```

Case/queue/event list responses contain `{items,nextCursor}`. Pass both `before` and `beforeId` from `nextCursor`; `limit` defaults to 50 and is bounded to 100. Case filters: `status`, `queueId`, `assignedOperatorId`. Events are newest first. Cross-workspace IDs return 404 after workspace authorization.

## Local checks and limitations

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. Dedicated API tests cover duplicate escalation, claim and reply/resolve races, exclusive assignment, tenant boundaries, state validation, event immutability, controller exclusion, multiple cases and retention protection. The isolated migration test checks pre-upgrade pending/active/resolved data and conversation-deletion cascades. Existing channel API/browser tests exercise compatibility.

For manual testing, start a customer chat and request human support, then open the workspace’s Human Support section. The existing Channels inbox remains compatible. Open **Human Support** for the dedicated staff console. Administrators can create manual queues, assign queued cases and choose their queue. Operators claim cases or accept cases assigned to them, reply to customers, save private notes, change waiting status and resolve. Phase C adds profiles and deterministic routing through Operators & routing, as described below. Phase D adds policy-controlled offers, AI triage and private handoff briefs. Phase E adds the private operator copilot; SLA and staffing notifications remain later phases. The full enrichment feature is complete only after the A–G acceptance flow passes.

## Phase B console

Apply migration **0018** and restart API/worker. Human Support is a first-class navigation item. Its overview displays real waiting, active, unassigned and own-case counts, optionally scoped to a queue. It deliberately omits SLA and available-operator counts until those systems exist.

Use the inbox filters for open/waiting/active/all/own/unassigned cases, queue, operator, status, priority and channel. Search matches case/conversation IDs, customer display name and issue text. Lists have explicit load-more controls. Selecting a case adds `supportCase` to the workspace URL so refresh restores it. Switching workspaces clears that selection.

The unified, paginated timeline includes persisted AI/customer messages, operator replies, system events and private notes across all interventions on the same conversation. Load earlier entries without losing the reading position. New entries scroll into view when the reader is at the bottom. AI responses retain their actual completed/failed/cancelled status. Case context shows existing identities, channel, queue, assignee, timestamps, controller and resolution; unavailable customer attributes and generated summaries are not invented.

Assignment requires supervisor access. The teammate selector lists eligible existing workspace users by display name, without exposing their email addresses or claiming they are online. Staff with `support:operator:view` can use the same bounded roster to filter cases. An operator accepts an assigned case before replying. Claim directly accepts an unassigned queued case. Reply, note and resolution controls require the assigned operator or a supervisor; analysts can inspect context but cannot write.

The composer separates **Customer reply** from **Internal note**. Notes are persisted in `support_notes`, referenced by append-only events and audited without copying their content. They never enter public handoff responses, normal message history or AI prompts. Changing case/filter or returning to the inbox prompts before discarding a composer draft. Resolution uses a confirmation dialog with required private summary, resolution code and optional final customer reply. The final reply and resolution commit in one transaction, and historical human replies remain visible to customers after resolution. The customer can continue AI chat on the same conversation; specialist-aware AI continuation is available in Phase F.

Additional API resources under `/workspaces/:workspaceId/support`:

| Method | Resource                  | Purpose                                                    |
| ------ | ------------------------- | ---------------------------------------------------------- |
| GET    | `/summary?queueId=...`    | Live case counts                                           |
| GET    | `/operators`              | Paginated eligible teammate names for assignment/filtering |
| GET    | `/cases/:caseId/timeline` | Paginated internal unified conversation timeline           |
| POST   | `/cases/:caseId/notes`    | Assigned operator/supervisor private note `{content}`      |

Case list filters additionally support `scope=all|open|waiting|active|mine|unassigned`, `priority`, `channel` and `search`. Assignment accepts optional `queueId` (UUID or null); a new queue must be enabled and in the same tenant. Resolve accepts optional `finalResponse`; private summary and note content never appear in public responses.

Browser validation and representative screenshots are recorded in `docs/validation.md` and `docs/support-console/`. Full operator profiles/routing, policy, copilot, structured continuation and SLA/analytics remain Phases C–G. Deployment automation and additional monitoring remain paused.

## Phase C operators and routing

Apply migration **0019** with `pnpm db:migrate`, then restart API and worker. In Human Support → **Operators & routing**, create reusable skills, add support profiles for existing eligible workspace members, and configure queue members and routing. Profiles include enablement, manual availability, capacity, priority weight, IANA timezone, language codes and skill proficiency (1–5). Administrators manage configuration; operators set only their own presence; analysts can inspect configuration and recommendations without changing them.

A profile starts offline. Operators choose Available, Busy, Away, Do Not Disturb or Offline in **My availability**. While Human Support is open and visible, non-offline presence is renewed every 20 seconds; the server expires it after 90 seconds without renewal. Availability is scoped to the workspace and never inferred from a login. Disabled profiles and disabled manual availability prevent new assignments, without interrupting existing cases. Operator timezone remains profile metadata; Phase G enforces the queue timezone and schedule.

Automatic candidates must have a currently eligible workspace role, an enabled profile, enabled membership in that queue, fresh Available presence and spare capacity. Assigned, active, waiting-customer and waiting-external cases all reserve capacity. Required skills and required languages are hard constraints. Disabling a skill immediately removes it from routing eligibility. Existing manual operators without an optional profile remain compatible; once a profile is configured, manual claims, supervisor assignments and reopening a resolved case enforce its availability and capacity too. Manual selection does not require an automatic skill/language match or Available presence. Capacity cannot be overridden in this release.

Queue settings and membership save in one transaction. The optional default queue receives new escalations without an explicit queue, including widget/hosted/playground requests; old open cases are not moved. Disabling a default queue leaves new requests unqueued for manual handling rather than silently selecting another queue. Queue members may have their own priority weight and enablement.

- **Manual:** no background assignment.
- **Round robin:** select the eligible member least recently assigned in this queue, with a stable ID tie-break. Membership edits preserve fairness timestamps.
- **Least loaded:** maximize the free-capacity ratio, with queue fairness as the tie-break.
- **Skill based:** rank required/preferred skill coverage plus normalized proficiency; required skills/language still filter eligibility.
- **Hybrid:** sum normalized skill, language, capacity, proficiency, priority, fairness and conversation-continuity factors multiplied by administrator-configured weights. Fairness reaches 1 after one hour without a queue assignment. Continuity considers the previous resolved specialist on the same conversation and never overrides eligibility or capacity.

Assignment modes are Manual, Recommend and Automatic. Recommend leaves the case queued; **Check routing match** shows current candidates and a supervisor can choose **Assign best match**. Automatic uses the same deterministic service in the worker, polling the durable PostgreSQL backlog every three seconds in batches of 25. Cases without a match stay queued and retry after 15 seconds; retry ordering prevents an unavailable head of the backlog from starving later requests. No AI model is used for Phase C routing. Automatic assignments still require operator acceptance before customer replies.

Conversation/case locks precede a workspace-scoped transaction advisory lock for capacity reservations. Manual and background assignments share it, preventing over-allocation across different conversations and multiple workers. Repeated processing cannot reassign an already assigned case. Routing strategy, score, policy snapshot, chosen operator, factors and load at assignment are stored on the case and in an append-only `routing.assigned` event. The console displays the recorded factors without exposing internal notes to customers. Human configuration/actions also appear in general audit logs; system routing history is recorded in support events without inventing a system user identity.

Additional APIs under `/workspaces/:workspaceId/support`:

| Method           | Resource                                  | Behavior                                                                                    |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET              | `/profiles`, `/operators/:userId/profile` | Paginated configured profiles or a single eligible profile, workload and effective presence |
| PUT              | `/operators/:userId/profile`              | Supervisor replaces validated profile and skills                                            |
| POST             | `/operators/:userId/presence`             | Eligible operator renews their own presence                                                 |
| GET / POST / PUT | `/skills`, `/skills/:skillId`             | List/create/update or disable reusable skills                                               |
| GET / PUT        | `/queues/:queueId/members`                | Read/replace bounded queue membership while preserving fairness                             |
| PATCH            | `/queues/:queueId`                        | Update routing policy and optionally membership atomically                                  |
| GET              | `/cases/:caseId/routing`                  | Current deterministic recommendations; no assignment                                        |
| POST             | `/cases/:caseId/route`                    | Supervisor applies the best currently eligible match                                        |

Phase D now adds validated AI triage and language/skill suggestions. Phase G adds bounded acceptance timeouts and fallback queues. Capacity constraints remain enforced; unmatched requests stay queued. Phase E adds the private copilot below; Phase F adds structured AI continuation below; SLA/notifications are implemented in Phase G below. Deployment automation and additional monitoring remain paused.

## Phase D escalation policy and AI handoff

Apply migration **0020** and restart API and worker. Under **Human Support → Handoff policy**, configure workspace defaults or a complete agent/deployment override. Precedence is deployment → agent → workspace → built-in defaults. Reset removes only the selected override. Existing conversations use the current effective access policy; confirmed cases retain their policy snapshot and revision for provenance.

Human access defaults to **AI-controlled offers**, with two explicit requests required. **Always available** exposes the request button after the first chat turn; **Disabled** blocks customer requests at the server. The legacy widget, hosted chat and playground all enforce the same policy. Existing open support sessions continue to accept customer messages even if access is subsequently disabled. Staff can still manually escalate through the support case API.

The runtime evaluates the last 20 customer turns since the most recent case or declined/confirmed offer. Exact repeated questions of at least eight normalized characters, or repeated statements that the answer did not help, count toward the default three-attempt resolution-loop threshold. Two failed tool/MCP runs produce a tool-failure offer by default. These are explicit heuristics, not a claim of semantic similarity or calibrated confidence. Ordinary provider failures alone do not count as tool failures; repeated human requests still work when chat generation fails. Explicit-request detection currently recognizes common English phrases; administrators can use Always available for languages that need direct access.

An offer preserves AI control. Customers choose **Connect me** or **Keep trying with AI**. Declining resets the detection window. Offers expire after 30 minutes. Confirmation checks the current policy and locks the conversation before creating one case; a stale offer cannot bypass Disabled access. The offer, decision signals, source run and confirmation event remain internal records. Guests see only whether support is available and the offer's fixed reason code.

**Allow AI to recommend a handoff**, persistent frustration evaluation and configured human-required intents are opt-in. They invoke an internal `request_human_handoff` structured decision on chat turns that have no deterministic trigger. It receives a bounded recent transcript, returns a strict schema and can only recommend an offer. It cannot assign an operator or perform an external action. Persistent frustration additionally requires at least two unsuccessful customer statements. Malformed or unavailable model decisions fail closed without blocking deterministic access. Decision usage has purpose `support_handoff_decision` and is stored separately from the main chat run's token totals.

### Structured triage and brief

Confirmed customer cases automatically queue one triage job when either AI triage or handoff summaries are enabled. Both default to enabled. Select a workspace model or use the conversation's pinned model. The API and worker resolve the selected encrypted workspace credential through the existing provider-neutral adapters and endpoint restrictions. There are no new secrets to configure.

One bounded provider call produces a strict triage result and private brief: intent/category, suggested priority, language, known skill names, sentiment/complexity, summary, escalation reason, observed customer context/actions and suggested next action. Input includes at most 20 persisted AI/customer messages and 20 tool outcome identifiers/status/error codes. Tool arguments/results, credentials and private operator notes are excluded. The input has a conservative model-context budget; the configurable output budget is capped by the registered model and 8,192 tokens. Provider time is bounded to 30 seconds. Provenance stores purpose `support_triage`, provider/model, usage when returned, source message/tool execution IDs and generation time. A failed refresh retains the last successful brief with its original generation provenance; failure status/code describe the latest attempt.

AI output never assigns users. Recognized workspace skill names and inferred language become preferences for deterministic routing. Only administrator intent rules can add mandatory skill IDs, select an enabled workspace queue and change priority. Queue-required skills/language still apply. Disabled mandatory skills cannot silently broaden eligibility. If AI triage is disabled but summaries are enabled, the generated brief does not change routing.

Automatic routing waits for pending/running triage; manual claim and customer messaging remain available. Validated completion releases routing immediately. Invalid JSON, unsupported fields, missing credentials, provider failure or context limits preserve the default queue and raw transcript. Lease recovery handles at most 25 expired jobs per iteration. Jobs use a 60-second lease; expired running jobs fail rather than automatically repeating model charges. The worker can process subsequent jobs after a failure. No model call holds conversation/case locks. Concurrent workers and stale lease results cannot overwrite another job's result.

The private case context displays **AI handoff brief**, provenance and a reminder to verify model suggestions against the conversation. Operators can request a bounded manual refresh; pending/running requests are deduplicated and the endpoint permits five requests per minute. Analysts can read the brief and policies but cannot refresh or change configuration. Briefs and triage metadata are never copied to guest handoff events or customer chat prompts. Phase E adds relevant knowledge suggestions and operator copilot actions below; approved post-resolution AI context is described below.

### Phase D API

Resources below use `/workspaces/:workspaceId/support` and existing sessions/RBAC:

| Method             | Resource                                   | Purpose                                      |
| ------------------ | ------------------------------------------ | -------------------------------------------- |
| GET / PUT / DELETE | `/policy?scope=workspace`                  | Read/save/reset workspace policy             |
| GET / PUT / DELETE | `/policy?scope=agent&targetId=<UUID>`      | Agent complete override                      |
| GET / PUT / DELETE | `/policy?scope=deployment&targetId=<UUID>` | Deployment complete override                 |
| GET                | `/policy/targets`                          | Scoped target/model choices (up to 200 each) |
| POST               | `/cases/:caseId/brief/refresh`             | Queue a private brief/triage refresh         |

Customer handoff GET responses now include `access: {entryMode,canRequest,offer}`. Existing authenticated/guest-token handoff POST routes accept `request` to confirm an offer or use Always available, and `dismiss` to keep trying with AI. They retain existing deployment, token, origin and conversation-owner checks. Public callers cannot supply queues, policies, priorities, operator IDs or triage content.

Phase E adds the private operator copilot below. Structured resolution and AI continuation are available in Phase F; SLA/notifications/analytics are implemented in Phase G below. Deployment automation and additional monitoring remain paused.

## Phase E private operator copilot

Activate an assigned case in **Human Support** to reveal **Private AI copilot**. Assigned operators and supervisors can request a suggested reply, conversation summary, relevant knowledge, or next action. Use draft copies a suggestion into the customer-reply composer; operators edit and explicitly send it. Replacing an existing reply or private-note draft requires confirmation. Regenerate makes an explicit new request; Ignore dismisses a suggestion locally. Generated drafts never enter customer messages automatically.

**Handoff policy** controls copilot availability, an optional workspace copilot model and a 256–8192 output token budget. The conversation's pinned model is the fallback. Every request uses the existing provider abstraction with a 30-second deadline and a bounded recent transcript. Internal notes, raw tool inputs/results, credentials and unrelated cases are excluded. Sentiment is an AI estimate to verify, not an established fact.

Knowledge retrieval uses only the conversation agent's attached knowledge bases, current ready sources and tenant-scoped embeddings. Citations show source titles and reference passages. Approved attached tools visible to the operator may be recommended by ID/name; copilot does not execute them or pre-fill arbitrary parameters. Next actions are limited to requesting information, permitted resolution and permitted supervisor escalation. Fabricated tool IDs, citation references and unavailable actions fail validation. Tool execution and similar-case history are deliberately absent from this phase.

Private results, citations and usage are stored in `support_copilot`, with a tenant-consistent case foreign key and cascading conversation retention. One generation per case runs at a time. Identical unchanged requests reuse successful results; changed transcript, role, model/policy or attachment/source revision invalidates that cache. Explicit regeneration bypasses successful-result reuse. Failed/expired calls do not retry automatically or block manual support. A 60-second lease lets the next read/request report a crashed generation as failed and permits explicit retry. Both routes enforce current controller and workspace access; generation rechecks permissions and attachments after the provider returns. Archived or revoked attachments and deleted/non-ready sources prevent reading prior affected results.

API: `GET` / `POST /workspaces/:workspaceId/support/cases/:caseId/copilot`. POST accepts `{kind: "reply" | "summary" | "knowledge" | "next_action", regenerate?: boolean}` and permits five requests per minute. Results are staff-only and never added to public handoff events, customer prompts or widget responses. General audit/events record identifiers and safe codes, not generated text. Usage purposes include `copilot_reply`, `copilot_summary`, `copilot_knowledge` and `copilot_next_action`; these private records are separate from main-chat dashboard totals. Summaries are cached/stored; there is no new background worker for copilot.

Apply migration **0021** and restart API/worker after updating. No additional environment variables are required. Phase F adds structured human-to-AI continuity below; SLA/notifications/analytics are implemented in Phase G below. Deployment automation and additional monitoring remain paused.

## Phase F: approved human-to-AI continuation

Resolution separates the required **private resolution summary** from facts explicitly approved for customer-facing AI. Operators can share the issue, resolution, completed actions, reference IDs, expected next step and actions not to repeat. The resolution dialog also lists attached tools that the AI must not run again. Approval, the optional final customer reply, case resolution and conversation control transition commit together.

When sharing is off, resolution still succeeds without an AI provider: it records the customer-visible final reply (if supplied) or a generic closure. Private summaries and notes are never inferred into approved facts. Existing private legacy resume records remain private and are not backfilled as approvals.

Enable **reviewed resolution proposals** together with the operator copilot in support policy to request optional AI suggestions in the resolution dialog. A dedicated workspace resolution model is optional; the copilot/pinned conversation model is the fallback. Operators must review proposals before confirming. Unavailable or invalid suggestions do not prevent manual resolution. Suggestions cannot select blocked tool IDs automatically.

**Return to AI** is enabled by default. Disabling it resolves the case but leaves the same conversation in `returning_to_ai`, with customer chat paused. After enabling it, an authorized case controller uses **Resume AI**. A stale case cannot resume a conversation controlled by a newer intervention. Reopening a case restores human control and clears its approval.

Subsequent AI turns retain existing AI history and add up to three approved resolutions and twelve public support messages, bounded to 12,000 UTF-8 bytes. Public support-message inclusion can be disabled independently. Internal notes, private resolution summaries and private copilot suggestions are excluded. Each approval is bounded to 8,000 bytes and validated against the workspace and pinned agent attachments. The customer sees a subtle return notice and continues on the same conversation.

Explicitly blocked tool IDs are excluded before planning and execution across approved resolved cases. Natural-language instructions such as “do not verify identity again” guide the model; wording compliance depends on the provider. Approved context is presented as untrusted factual data, not authority to override runtime instructions.

Apply migration **0022** with `pnpm db:migrate` and restart API/worker. No new environment variables or services are required. Phase G operational maturity is implemented below. Deployment automation and additional monitoring remain paused.

## Phase G: support operations

**Operators & routing → Configure routing** now includes queue SLA targets, warning thresholds, assignment acceptance timeout/attempt limits, business hours, timezone, outside-hours behavior and a fallback queue. Targets are optional, measured in elapsed wall-clock seconds and snapshotted per case. Resolution time pauses in `waiting_customer` by default; pausing in `waiting_external` is optional. Assignment and first-response clocks do not pause. Timely completed targets remain on track. Queue changes before the first assignment use the selected queue's targets; transfers retain the existing case's targets. Reopening excludes the resolved interval from resolution time and records a reopen count.

The existing worker scans bounded batches for SLA warning/breach changes and assignment expiry. Alerts are deduplicated per target/state transition. Acceptance after its deadline is rejected; expiry requeues the same case, releases capacity and excludes the expired operator from subsequent automatic choices. Once the configured number of automatic attempts is exhausted, the case stays queued for explicit supervisor action. Manual reassignment remains available. AI never gains control during timeout or transfer.

Schedules use IANA timezones and same-day minute ranges, including DST. Closed queues never automatically assign. `continue_with_ai` prevents a customer handoff and explains the closure; offline-case, collect-message and show-hours modes keep a durable case with customer-visible schedule information. Fallback routing follows enabled tenant-scoped queues with cycle/depth validation, including when a queued request's original queue closes. Manual operator actions can service offline cases. Holiday exceptions remain future work.

Assigned operators and supervisors can **Transfer case** to an enabled queue, optionally reserving another eligible operator; the receiving operator must accept. Supervisors can change priority with a required reason. Transfers, priority changes, expiry, resolution and reopening retain their events/audit trail. The inbox includes SLA, detected-language and UTC creation-date filters.

**Notifications** contains recipient-scoped, durable in-app updates for new/assigned/transferred cases, customer replies, acceptance expiry and SLA warnings/breaches. Opening a notification acknowledges it idempotently and opens the case. Notifications contain identifiers and event kinds, never message bodies, notes or private summaries. Email, Slack, Teams and push notification delivery are future adapters; no external notification service is required.

**Supervision** shows live backlog, unassigned/urgent cases, warning/breached targets, queue health and operator presence/capacity. Supervisors act through the case inbox. **Analytics** is available to support readers/analysts: 7/30/90-day windows and queue filters show case counts, handoff rate, AI return counts, service-time averages, P50/P95 wait, SLA breaches, queue/operator summaries, transfer/reopen counts, handoff reasons and copilot request outcomes. The no-handoff percentage is explicitly a containment proxy, not proof of resolution. Deflection and business savings are not fabricated without a baseline. Reports describe retained records with current/final queue/operator ownership, not a historical attribution ledger; summary tables list up to 100 queues/operators.

Authenticated operator and authorized customer/widget SSE streams emit content-free invalidations, revalidate access on every check, close after 25 seconds and reconnect. Public streams retain conversation token, deployment and widget-origin checks. Clients refresh durable projections; five-second polling remains a fallback. Maintenance-only case clock updates do not generate workspace refresh storms.

Apply migration **0023** with `pnpm db:migrate` and restart API/worker/web. No new environment variables or dependencies are required. Phases A–G complete the initial Human Support enrichment scope. Deployment automation and additional infrastructure monitoring remain paused; the next workstream is the requested UI enhancements.

Phase G API routes are under `/workspaces/:workspaceId/support`:

| Route | Access / behavior |
| --- | --- |
| `GET /analytics?days=30&queueId=…` | Support analytics readers; 1–90 days, optional queue filter. |
| `GET /supervision` | Supervisors; backlog, queue health and operator capacity. |
| `GET /notifications` | Current recipient only; stable cursor pagination and unread count. |
| `POST /notifications/:notificationId/read` | Current recipient only; idempotent acknowledgement. |
| `POST /cases/:caseId/transfer` | Current controller; `{queueId, operatorId?: UUID \| null, reason}`. |
| `POST /cases/:caseId/priority` | Supervisors; `{priority, reason}`. |
| `GET /stream` | Workspace support readers; authorized content-free SSE invalidations. |

Customer handoff routes also expose `/stream` with their existing conversation authorization and widget-origin checks. Queue create/update accepts the validated `operations` configuration; existing queues retain disabled SLA targets and unrestricted hours until configured.
