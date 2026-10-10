# Human support enrichment

The [implementation specification](human-support-spec.md) is the next product roadmap. Deployment automation and additional monitoring work are paused at the user's request. Existing readiness, recovery and retention features remain available.

## Delivery phases

| Phase | Scope                                                                                        | Status                                            |
| ----- | -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| A     | Cases, events, queues, conversation control, migration, permissions, basic APIs              | Implemented; validation recorded in validation.md |
| B     | Dedicated Human Support console, filters, unified timeline, internal notes, operator actions | Implemented; validation recorded in validation.md |
| C     | Operator profiles, presence, skills, languages, capacity and routing                         | Implemented; validation recorded in validation.md |
| D     | Escalation policy, AI triage and handoff brief                                               | Planned                                           |
| E     | Private operator copilot                                                                     | Planned                                           |
| F     | Structured resolution, AI continuation and flagship AI → human → AI test                     | Planned                                           |
| G     | SLA, business hours, notifications, supervision and analytics                                | Planned                                           |

## Phase A architecture

A conversation remains the customer journey. Each escalation creates a support case on that conversation; later escalations create additional cases. PostgreSQL enforces at most one open case per conversation. `conversation_mode` is the authoritative controller: `ai`, `waiting_human`, `human` or `returning_to_ai`. The last mode is reserved for the controlled continuation work in Phase F.

The case service locks the conversation before its case. AI run creation, support actions and retention use that same conversation lock. A running AI response prevents support activation, and every mode other than `ai` blocks new autonomous responses. No model service is called to create, claim, reply to or resolve a case.

Events are durable and cannot be updated. Tenant-consistent composite foreign keys bind cases to conversations, queues and event histories. Assignment additionally requires workspace membership at the database boundary and eligible RBAC permissions in the service. Support message content remains in support events and the compatibility thread; general audit records contain action identifiers rather than message bodies. Retention protects open cases and removes support cases/events with an eligible expired conversation.

## Migration and compatibility

Run `pnpm db:migrate` to apply **0017–0019**, then restart API and worker. No additional credentials are needed. Migration 0017 preserves `handoff_events` and copies their IDs, content, actors and timestamps into the support timeline. Every legacy non-`none` handoff becomes a historical case: pending → queued, active → active, resolved → resolved. Legacy threads lack reliable case boundaries, so a migrated thread is represented by one case; new escalations have separate case IDs.

Widget, hosted-chat, playground and Channels inbox endpoints still work. Their legacy status/event fields are maintained by the same case service, rather than a second state machine. Duplicate legacy requests/claims keep returning 409 as existing clients expect. The new case API returns the existing open case for duplicate escalation and supports an optional UUID `idempotencyKey` for exact request retries. Reusing a key for a different conversation returns 409.

**Assignment is now exclusive.** An assigned operator or supervisor can reply/change status/resolve. Claim is atomic; another operator receives 409. Workspace and organization administrators have supervisor permissions. Builders and operators can view, claim, reply and resolve their cases. Analysts can read cases/queues, but cannot mutate them. Existing users, sessions and memberships are reused.

## Case state machine

Normal lifecycle: requested → triaging → queued → assigned → active → resolved → closed. Manual escalation initially creates a queued case. Claim directly accepts a queued case, whereas supervisor assignment creates an assigned case for operator acceptance through the status endpoint.

An active case can wait for the customer or an external party, then become active again or resolve. Returning an active/assigned case to queued removes its assignee. Requested/triaging/queued/assigned cases may be cancelled. A resolved case may reopen if no other open case exists; a closed case requires a new escalation. Closing an old case never changes a newer case's controller. Invalid transitions return 409.

Resolving an active case stores its code, summary and initial resume-context record and returns the same conversation to AI control. Rich validated resolution context, support-message inclusion in the model prompt and no-repeat guarantees are **Phase F work**. Phase A does not yet make the model aware of the specialist's actions.

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

For manual testing, start a customer chat and request human support, then open the workspace’s Human Support section. The existing Channels inbox remains compatible. Open **Human Support** for the dedicated staff console. Administrators can create manual queues, assign queued cases and choose their queue. Operators claim cases or accept cases assigned to them, reply to customers, save private notes, change waiting status and resolve. Phase C adds profiles and deterministic routing through Operators & routing, as described below. Policy-controlled offers, AI triage, the private copilot, SLA and staffing notifications remain later phases. Phase A retains the legacy explicit request button; Phase D will introduce AI-controlled escalation defaults. The full enrichment feature is complete only after the A–G acceptance flow passes.

## Phase B console

Apply migration **0018** and restart API/worker. Human Support is a first-class navigation item. Its overview displays real waiting, active, unassigned and own-case counts, optionally scoped to a queue. It deliberately omits SLA and available-operator counts until those systems exist.

Use the inbox filters for open/waiting/active/all/own/unassigned cases, queue, operator, status, priority and channel. Search matches case/conversation IDs, customer display name and issue text. Lists have explicit load-more controls. Selecting a case adds `supportCase` to the workspace URL so refresh restores it. Switching workspaces clears that selection.

The unified, paginated timeline includes persisted AI/customer messages, operator replies, system events and private notes across all interventions on the same conversation. Load earlier entries without losing the reading position. New entries scroll into view when the reader is at the bottom. AI responses retain their actual completed/failed/cancelled status. Case context shows existing identities, channel, queue, assignee, timestamps, controller and resolution; unavailable customer attributes and generated summaries are not invented.

Assignment requires supervisor access. The teammate selector lists eligible existing workspace users by display name, without exposing their email addresses or claiming they are online. Staff with `support:operator:view` can use the same bounded roster to filter cases. An operator accepts an assigned case before replying. Claim directly accepts an unassigned queued case. Reply, note and resolution controls require the assigned operator or a supervisor; analysts can inspect context but cannot write.

The composer separates **Customer reply** from **Internal note**. Notes are persisted in `support_notes`, referenced by append-only events and audited without copying their content. They never enter public handoff responses, normal message history or AI prompts. Changing case/filter or returning to the inbox prompts before discarding a composer draft. Resolution uses a confirmation dialog with required private summary, resolution code and optional final customer reply. The final reply and resolution commit in one transaction, and historical human replies remain visible to customers after resolution. The customer can continue AI chat on the same conversation; specialist-aware AI continuation remains Phase F.

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

A profile starts offline. Operators choose Available, Busy, Away, Do Not Disturb or Offline in **My availability**. While Human Support is open and visible, non-offline presence is renewed every 20 seconds; the server expires it after 90 seconds without renewal. Availability is scoped to the workspace and never inferred from a login. Disabled profiles and disabled manual availability prevent new assignments, without interrupting existing cases. A timezone is profile metadata; business-hours enforcement belongs to Phase G.

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

AI triage and language/skill inference are Phase D. Automatic acceptance timeouts, fallback queues and capacity overrides are not implemented; unmatched requests remain queued. The private copilot, structured AI continuation and SLA/notifications remain later phases. Deployment automation and additional monitoring remain paused.
