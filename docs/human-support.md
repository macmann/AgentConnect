# Human support enrichment

The [implementation specification](human-support-spec.md) is the next product roadmap. Deployment automation and additional monitoring work are paused at the user's request. Existing readiness, recovery and retention features remain available.

## Delivery phases

| Phase | Scope                                                                                        | Status                                            |
| ----- | -------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| A     | Cases, events, queues, conversation control, migration, permissions, basic APIs              | Implemented; validation recorded in validation.md |
| B     | Dedicated Human Support console, filters, unified timeline, internal notes, operator actions | Next                                              |
| C     | Operator profiles, presence, skills, languages, capacity and routing                         | Planned                                           |
| D     | Escalation policy, AI triage and handoff brief                                               | Planned                                           |
| E     | Private operator copilot                                                                     | Planned                                           |
| F     | Structured resolution, AI continuation and flagship AI → human → AI test                     | Planned                                           |
| G     | SLA, business hours, notifications, supervision and analytics                                | Planned                                           |

## Phase A architecture

A conversation remains the customer journey. Each escalation creates a support case on that conversation; later escalations create additional cases. PostgreSQL enforces at most one open case per conversation. `conversation_mode` is the authoritative controller: `ai`, `waiting_human`, `human` or `returning_to_ai`. The last mode is reserved for the controlled continuation work in Phase F.

The case service locks the conversation before its case. AI run creation, support actions and retention use that same conversation lock. A running AI response prevents support activation, and every mode other than `ai` blocks new autonomous responses. No model service is called to create, claim, reply to or resolve a case.

Events are durable and cannot be updated. Tenant-consistent composite foreign keys bind cases to conversations, queues and event histories. Assignment additionally requires workspace membership at the database boundary and eligible RBAC permissions in the service. Support message content remains in support events and the compatibility thread; general audit records contain action identifiers rather than message bodies. Retention protects open cases and removes support cases/events with an eligible expired conversation.

## Migration and compatibility

Run `pnpm db:migrate` to apply **0017**, then restart API and worker. No additional credentials are needed. Migration 0017 preserves `handoff_events` and copies their IDs, content, actors and timestamps into the support timeline. Every legacy non-`none` handoff becomes a historical case: pending → queued, active → active, resolved → resolved. Legacy threads lack reliable case boundaries, so a migrated thread is represented by one case; new escalations have separate case IDs.

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

For manual testing, start with the existing Channels inbox and a widget or agent playground chat. Use the support APIs to configure manual queues and inspect cases until Phase B exposes their console. There is no operator profile, automatic routing, policy-controlled offer, internal-note editor, copilot, SLA or staffing notification yet. Queue configuration rejects automated strategies until Phase C rather than pretending to route. Phase A retains the legacy explicit request button; Phase D will introduce AI-controlled escalation defaults. The full enrichment feature is complete only after the A–G acceptance flow passes.
