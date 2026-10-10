# AgentConnect — Human Support, Intelligent Handoff & AI Copilot

## Implementation-Grade Product Requirements Specification

### Objective

Extend the existing AgentConnect human handoff capability into a production-grade Human Support and Intelligent Handoff module suitable for enterprise customer service, contact centers, internal service desks, banking, healthcare, government and other support-oriented deployments.

This is NOT a separate support application.

It must be a native AgentConnect capability tightly integrated with:

- Conversations
- AI agents
- Agent deployments
- Website widget
- Hosted chat
- Future messaging channels
- Workspaces
- Organizations
- Existing users and RBAC
- Agent tools
- Workflows
- Knowledge bases
- Audit logs
- Usage analytics
- Existing human handoff functionality

The primary product principle is:

> One customer conversation can move seamlessly between AI and human control without creating a new chat or losing context.

The desired lifecycle is:

```text
Customer
   ↓
AI Agent
   ↓
AI attempts resolution
   ↓
Escalation required
   ↓
Support Case created
   ↓
Queue selected
   ↓
Operator assigned
   ↓
Human takes control
   ↓
AI becomes operator copilot
   ↓
Human resolves case
   ↓
Structured resolution generated
   ↓
Context returned to AI
   ↓
AI resumes same conversation
   ↓
Customer continues chatting
```

A conversation may contain multiple support cases over its lifetime.

Example:

```text
Conversation ABC

AI
AI
AI

Support Case #1
  ├── escalation
  ├── human interaction
  └── resolution

AI
AI

Support Case #2
  ├── escalation
  ├── human interaction
  └── resolution

AI
AI
```

Do not treat human support as a terminal state.

---

# 1. CURRENT SYSTEM — PRESERVE AND MIGRATE

Before implementation, inspect the current repository thoroughly.

Relevant existing areas include at minimum:

```text
apps/api/src/channels.ts
apps/web/components/handoff-panel.tsx
apps/web/components/channels-studio.tsx
apps/web/components/chat-panel.tsx
apps/web/components/hosted-chat.tsx
packages/db/migrations/0009_channels.sql
packages/db/src/schema.ts
packages/schemas/src/channels.ts
apps/api/test/channels.test.ts
tests/browser/channels.spec.mjs
docs/channels-voice.md
docs/product-spec.md
docs/architecture.md
docs/security.md
```

The current implementation already has concepts such as:

```text
conversation.handoff_status

none
pending
active
resolved
```

and handoff events such as:

```text
requested
claimed
user_message
operator_message
resolved
```

Do not break existing deployments.

Existing handoff records must continue working after migration.

Create backwards-compatible migrations where practical.

The new implementation should progressively supersede the simplistic handoff model while preserving existing data.

---

# 2. PRODUCT GOALS

The Human Support module must achieve six primary business goals.

## 2.1 AI-first containment

The default customer experience should encourage AI resolution before involving a human.

Do not expose an unrestricted permanent human-support escape button unless workspace policy explicitly enables it.

The platform should support:

```text
AI attempt
→ clarification
→ recovery
→ escalation offer
→ human
```

rather than:

```text
AI
→ always-visible human button
→ human
```

The purpose is to improve:

- AI containment rate
- support deflection
- operator productivity
- support cost
- response time

without trapping customers inside an ineffective AI loop.

---

# 2.2 Seamless human takeover

When human support begins:

- keep the same conversation
- keep the same customer UI
- preserve full history
- stop AI customer-facing responses
- allow customer and operator to message each other
- show a visible but unobtrusive status that a human has joined
- preserve conversation identity
- preserve channel identity

The customer must not feel like they were transferred into another product.

---

# 2.3 Seamless AI return

When human support ends:

- do not create a new AI conversation
- do not forget what the human accomplished
- generate structured resolution context
- resume AI using previous AI context plus approved human resolution context
- avoid repeating already completed troubleshooting
- allow the customer to continue normally

Human → AI continuity is mandatory.

---

# 2.4 Intelligent routing

Support cases must support:

- manual assignment
- manual claim
- round-robin assignment
- least-loaded assignment
- skill-based assignment
- language-based assignment
- queue-based assignment
- priority-based assignment
- AI-assisted assignment
- fully automatic AI-assisted assignment

---

# 2.5 AI operator copilot

While a human controls the customer conversation, the AI should no longer answer the customer autonomously.

Instead, it should become a private operator assistant.

Examples:

- summarize conversation
- suggest replies
- find relevant knowledge
- show customer context
- identify intent
- identify sentiment
- recommend next actions
- suggest tools
- summarize tool output
- draft resolution
- recommend escalation
- surface similar cases where available

The human must remain in control.

---

# 2.6 Enterprise operations

The system must support:

- multiple queues
- teams
- operator skills
- operator presence
- operator capacity
- SLAs
- priorities
- assignment histories
- supervisors
- internal notes
- analytics
- audit logs
- tenant isolation
- workspace-level configuration

---

# 3. DOMAIN MODEL

Do not overload the Conversation entity with every support concept.

The domain should separate:

```text
Conversation
SupportCase
SupportQueue
OperatorProfile
OperatorSkill
SupportAssignment
SupportEvent
SupportNote
SupportResolution
SupportPolicy
```

---

# 4. CONVERSATION MODEL

Conversation remains the canonical customer interaction.

Add or formalize:

```text
conversation_mode
```

Allowed conceptual values:

```text
ai
waiting_human
human
returning_to_ai
```

Prefer this over using `handoff_status` as the sole source of truth.

Maintain existing `handoff_status` temporarily if needed for backwards compatibility.

Eventually the relationship should be:

```text
Conversation
    |
    ├── active controller
    |
    └── zero or more SupportCases
```

Conversation should also expose:

```text
active_support_case_id nullable
controller_type
last_customer_message_at
last_agent_message_at
last_human_message_at
```

Do not duplicate conversation messages unnecessarily.

---

# 5. SUPPORT CASE

Create a durable `support_cases` entity.

Suggested fields:

```text
id UUID PK

organization_id
workspace_id
conversation_id

status

reason_code
reason_text

trigger_type

priority
priority_score

queue_id nullable

assigned_operator_id nullable
assigned_team_id nullable

routing_strategy
routing_score nullable
routing_explanation jsonb

required_skills jsonb or relational mapping
detected_language nullable
detected_intent nullable
sentiment nullable
sentiment_score nullable

ai_summary text nullable
ai_handoff_context jsonb nullable

requested_at
queued_at
assigned_at
accepted_at
first_response_at
resolved_at
closed_at

resolution_code nullable
resolution_summary nullable
ai_resume_context jsonb nullable

created_at
updated_at
```

Support case statuses:

```text
requested
triaging
queued
assigned
active
waiting_customer
waiting_external
resolved
closed
cancelled
```

Do not collapse all states into pending/active/resolved.

---

# 6. SUPPORT CASE STATE MACHINE

Valid high-level transitions:

```text
requested
   ↓
triaging
   ↓
queued
   ↓
assigned
   ↓
active
   ├── waiting_customer
   ├── waiting_external
   └── active
   ↓
resolved
   ↓
closed
```

Optional transitions:

```text
requested → cancelled
queued → cancelled
assigned → queued      // rejected or timeout
active → queued        // transfer
resolved → active      // reopen
closed → new case      // do not reopen indefinitely
```

Enforce transitions server-side.

Do not trust UI state.

Invalid transitions must return a conflict error.

Use database transactions and row locking where concurrency matters.

---

# 7. SUPPORT EVENTS

Generalize the existing handoff event concept.

Support events should be immutable.

Recommended types include:

```text
case_created
escalation_requested
escalation_offered
escalation_confirmed

triage_started
triage_completed

queue_selected
queue_changed

assignment_started
assigned
assignment_recommended
assignment_accepted
assignment_rejected
assignment_timeout
operator_joined
operator_left
operator_transferred

customer_message
operator_message

internal_note_added

status_changed

priority_changed
skill_requirement_changed

waiting_customer
waiting_external

resolution_started
resolution_generated
resolved
reopened
closed

ai_control_paused
ai_control_resumed

copilot_suggestion_generated
copilot_suggestion_used

sla_warning
sla_breached
```

Each event should support:

```text
id
support_case_id
conversation_id
organization_id
workspace_id

type

actor_type:
system
customer
ai
operator
supervisor

actor_id nullable

payload jsonb

created_at
```

Avoid putting sensitive message content into general audit logs.

---

# 8. CUSTOMER-FACING ESCALATION POLICY

Create configurable escalation behavior per agent/deployment.

This is essential.

Configuration should support:

## Human support availability

```text
disabled
policy_controlled
always_available
```

Default:

```text
policy_controlled
```

Do NOT default to always visible.

---

# 9. HUMAN ESCALATION TRIGGERS

Support escalation may be triggered by:

### Explicit customer request

Examples:

```text
human
agent please
talk to somebody
real person
representative
operator
```

Do not escalate immediately on the first vague occurrence unless configured.

Policy should determine behavior.

Example:

```text
Customer:
I want a human.

AI:
I can help with most account issues here.
Let me try first — what are you trying to do?
```

After repeated explicit requests, honor the request.

Provide configurable:

```text
max_explicit_human_requests_before_offer
```

Suggested default:

```text
2
```

Do not make this deceptive or hostile.

If the customer clearly insists repeatedly, escalate.

---

## Resolution-loop detection

Detect repeated unsuccessful cycles.

Signals may include:

- user asks same question repeatedly
- AI provides materially similar answer repeatedly
- same tool repeatedly fails
- same clarification repeatedly requested
- conversation intent remains unresolved
- customer states answer did not help

Configurable threshold:

```text
max_resolution_attempts
```

Suggested default:

```text
2 or 3
```

---

## Agent-directed escalation

Introduce an internal runtime capability such as:

```text
request_human_handoff()
```

or equivalent internal structured decision.

This is not necessarily a normal external tool.

The agent can request escalation when:

- configured policy requires human authority
- action is outside available capability
- critical tool unavailable
- confidence is low
- required data cannot be obtained
- restricted action needs manual handling

The runtime must validate the request against workspace policy.

---

## Tool failure escalation

Examples:

```text
payment API unavailable
CRM unavailable
identity verification failed
refund tool repeatedly fails
external dependency unavailable
```

Configurable failure threshold.

---

## Intent-based escalation

Allow workspace administrators to configure intents requiring humans.

Examples:

```text
card_dispute
legal_complaint
fraud_report
medical_emergency_routing
account_closure
high_value_refund
VIP_complaint
```

---

## Sentiment/frustration escalation

Do NOT escalate merely because one message appears negative.

Use persistent/repeated frustration signals.

Possible factors:

```text
sentiment trajectory
repeated dissatisfaction
insults/frustration markers
failed attempts
explicit escalation language
```

Make feature configurable.

---

## Confidence-based escalation

If AgentConnect has meaningful confidence signals available, allow policy thresholds.

Do not fabricate numeric confidence from LLM prose if no reliable signal exists.

---

## Business rule escalation

Allow administrators to define conditions such as:

```text
transactionAmount > 5000
customerTier = VIP
refundAmount > approvalLimit
region = regulated_region
caseType = fraud
```

These should integrate with workflows/tools where applicable.

---

# 10. ESCALATION EXPERIENCE

When policy determines escalation may be appropriate, AI should offer it naturally.

Example:

```text
I've tried a couple of ways to resolve this and we're still not getting the result you need.

Would you like me to connect you with a support specialist?
```

UI:

```text
[ Connect me ]
[ Keep trying with AI ]
```

If customer confirms:

```text
support case created
→ triage
→ queue
→ assignment
```

The AI can continue collecting useful information while waiting if policy allows.

---

# 11. WAITING EXPERIENCE

While waiting for a human:

Customer should see:

```text
Connecting you with a support specialist…
```

Optionally:

```text
Estimated wait: ~2 minutes
```

Only display estimated time if a credible estimate exists.

The customer should be able to:

- send additional messages
- continue seeing prior conversation
- cancel human request where allowed

Optional policy:

```text
allow_ai_during_queue_wait
```

Possible modes:

```text
off
informational_only
full_assistance
```

Default recommended:

```text
informational_only
```

AI must not perform actions that conflict with the support case while waiting.

---

# 12. QUEUES

Create `support_queues`.

Suggested fields:

```text
id
organization_id
workspace_id

name
description

enabled

priority

routing_strategy

max_queue_size nullable

business_hours_config jsonb

sla_policy_id nullable

fallback_queue_id nullable

overflow_behavior

created_at
updated_at
```

Examples:

```text
General Support
Billing
Technical Support
Account Access
Card Disputes
Sales
VIP Support
Myanmar Language Support
```

---

# 13. QUEUE MEMBERSHIP

Create a mapping:

```text
support_queue_members
```

Fields:

```text
queue_id
user_id

priority_weight
enabled

created_at
```

An operator may belong to multiple queues.

---

# 14. OPERATOR PROFILE

Do not create a second user identity system.

Use existing workspace users.

Add an optional support profile.

Suggested entity:

```text
operator_profiles
```

Fields:

```text
organization_id
workspace_id
user_id

enabled

presence_status

capacity_limit

manual_availability

priority_weight

timezone

created_at
updated_at
```

Presence statuses:

```text
offline
available
busy
away
do_not_disturb
```

Presence is partly ephemeral.

Redis may be used for heartbeat/presence state.

PostgreSQL remains authoritative for configuration.

---

# 15. OPERATOR SKILLS

Create reusable skill definitions.

Examples:

```text
billing
technical_support
card_dispute
sales
account_recovery
fraud
VIP_support
```

Skill fields:

```text
id
workspace_id
name
description
enabled
```

Operator skill mapping:

```text
operator_id
skill_id
proficiency
```

Possible proficiency:

```text
1–5
```

or:

```text
basic
intermediate
advanced
expert
```

Keep it simple but extensible.

---

# 16. OPERATOR LANGUAGES

Support explicit languages separately from skills.

Example:

```text
en
de
my
th
```

Optional proficiency.

Routing may consider language as a hard or soft constraint.

---

# 17. OPERATOR CAPACITY

Each operator may define:

```text
max_concurrent_cases
```

System should calculate:

```text
active_case_count
available_capacity =
max_concurrent_cases - active_case_count
```

Do not assign new cases when:

```text
available_capacity <= 0
```

unless supervisor override or configured overflow behavior allows it.

---

# 18. ROUTING ENGINE

Create a dedicated routing service/domain.

Do not bury routing logic in `channels.ts`.

Conceptually:

```text
Support Case
    ↓
Triage
    ↓
Queue Selection
    ↓
Candidate Operators
    ↓
Eligibility Filter
    ↓
Scoring
    ↓
Assignment
```

---

# 19. ROUTING STRATEGIES

Support:

## Manual

No automatic assignment.

Case enters queue.

Operator/supervisor selects assignment.

---

## Round robin

Cycle eligible operators fairly.

Persist enough state to maintain fairness.

---

## Least loaded

Score operators primarily by active case count/capacity.

Example:

```text
Mary    1 / 5
John    4 / 5
Peter   3 / 4

Assign Mary
```

---

## Skill based

Only operators with required skill(s) qualify.

Support:

```text
required skills
preferred skills
```

---

## Language based

Prefer or require matching language.

---

## Hybrid weighted

Recommended production default.

Possible scoring components:

```text
skill match
language match
capacity
queue membership
operator proficiency
current workload
priority weighting
recent assignment fairness
customer continuity
```

Do not hard-code opaque arbitrary scoring.

Implement configurable weights.

---

# 20. AI-ASSISTED ROUTING

AI may analyze the conversation and return structured triage output.

Schema example:

```json
{
  "intent": "card_dispute",
  "category": "billing",
  "priority": "high",
  "language": "my",
  "requiredSkills": [
    "card_dispute"
  ],
  "preferredSkills": [
    "fraud"
  ],
  "sentiment": "frustrated",
  "complexity": "medium",
  "summary": "Customer reports an unknown card transaction.",
  "reason": "The agent cannot initiate a dispute automatically."
}
```

Validate with Zod.

Never accept arbitrary unvalidated model output.

AI should not directly assign arbitrary users.

AI produces triage signals.

Deterministic routing selects from eligible operators.

---

# 21. AI ASSIGNMENT MODES

Workspace/queue configuration:

```text
manual
recommend
automatic
```

### Manual

No AI recommendation.

### Recommend

AI/routing engine recommends:

```text
Recommended operator: Thiri
Match score: 94
```

Supervisor/operator chooses.

### Automatic

Routing automatically assigns the best eligible operator.

Store reasoning metadata.

---

# 22. ASSIGNMENT SCORING

Design a deterministic scoring layer.

Example conceptual formula:

```text
score =
  skill_match_weight
+ language_match_weight
+ availability_weight
+ capacity_weight
+ queue_weight
+ proficiency_weight
+ continuity_weight
- workload_penalty
```

Do not rely on LLM ranking alone.

Store:

```text
candidate_id
score
factors
timestamp
```

for explainability where appropriate.

---

# 23. CUSTOMER CONTINUITY

Prefer assigning the same operator if:

- operator handled the customer recently
- operator is still available
- relevant case context exists
- queue policy enables continuity

Call this:

```text
customer continuity preference
```

Do not let it override critical eligibility or capacity constraints.

---

# 24. ASSIGNMENT ACCEPTANCE

Configurable behavior:

```text
immediate_assignment
require_operator_acceptance
```

If acceptance required:

```text
Assigned
→ operator has N seconds
→ Accept / Reject
```

If timeout/rejection:

```text
return case to queue
→ reroute
```

Track assignment attempts.

---

# 25. TRANSFERS

Operators must be able to transfer:

```text
to another operator
to another queue
to supervisor
```

Transfer should preserve:

- conversation
- support case
- history
- notes
- AI summary
- customer context

Record transfer reason.

---

# 26. HUMAN SUPPORT CONSOLE

Create a first-class navigation area:

```text
Human Support
```

Do not hide the complete module under Channels.

Suggested main navigation:

```text
Agents
Workflows
Knowledge
Tools
Channels
Human Support
Quality
Operations
Settings
```

---

# 27. HUMAN SUPPORT HOME

Provide operational summary:

```text
Waiting
Active
SLA Risk
Unassigned
My Cases
Available Operators
```

Example:

```text
Waiting                12
Active                  28
SLA Risk                 3
Available Operators      9
```

Add queue-level filters.

---

# 28. SUPPORT INBOX LAYOUT

Desktop layout should resemble:

```text
┌──────────────┬────────────────────────────┬──────────────────────┐
│ Queues       │ Conversation               │ Context / Copilot    │
│              │                            │                      │
│ All          │ Customer                   │ Customer             │
│ General      │ AI                         │ Support Case         │
│ Billing      │ Customer                   │ AI Summary           │
│ Technical    │ Human                      │ Intent               │
│ VIP          │                            │ Sentiment            │
│              │ [message composer]         │ Relevant Knowledge   │
│              │                            │ Suggested Reply      │
│              │                            │ Suggested Actions    │
└──────────────┴────────────────────────────┴──────────────────────┘
```

Responsive layout required.

---

# 29. CASE LIST

Each case card/row should show useful operational information:

```text
customer/display identity
channel
queue
priority
status
wait duration
assigned operator
detected language
short issue summary
SLA state
latest message preview
```

Support filters:

```text
status
queue
operator
priority
channel
language
SLA state
assigned/unassigned
date
```

Support search by:

```text
conversation ID
case ID
customer identity where available
message content where permitted
```

Use proper pagination.

Do not retain the current hard limit of only an unpaged first 100 forever.

---

# 30. UNIFIED TIMELINE

Operator should see one chronological timeline.

Render visually distinct entries for:

```text
Customer
AI Agent
Human Operator
System Event
Internal Note
Tool Event where useful
```

Do not mix internal notes into customer-visible content.

Example:

```text
Customer
"I don't recognize this transaction."

AI Agent
"I found the transaction..."

SYSTEM
Escalated to Card Disputes

SYSTEM
Assigned to Thiri

Thiri — Support
"I'll review this for you."

INTERNAL NOTE
Customer identity already verified.
```

---

# 31. CUSTOMER PROFILE / CONTEXT PANEL

Where available show:

```text
customer name
customer/user ID
channel identity
language
timezone
conversation history
previous support cases
customer attributes
collected structured data
relevant tool outputs
```

Do not invent unavailable customer attributes.

---

# 32. AI HANDOFF BRIEF

When support begins, generate a structured operator brief.

Example:

```text
Reason for escalation
Unable to complete card dispute automatically.

Conversation summary
Customer reports an unknown MMK 450,000 debit card transaction.

Customer context
Account ending: 8944
Identity verification: completed

Actions already attempted
✓ Retrieved transaction
✓ Verified transaction status
✓ Checked dispute eligibility
✗ Could not initiate dispute

Detected intent
Card dispute

Language
Burmese

Sentiment
Frustrated

Suggested next action
Review transaction and initiate manual dispute workflow.

Relevant knowledge
Card Dispute SOP v3.2
```

The brief should be generated once during handoff and refreshable manually.

Avoid repeatedly spending tokens unnecessarily.

Store generated brief and provenance.

---

# 33. HUMAN OPERATOR COPILOT

While `conversation_mode = human`, AI must not automatically answer the customer.

Instead expose private copilot features.

Capabilities:

### Suggested reply

Generate a draft response.

Operator can:

```text
Use
Edit
Regenerate
Ignore
```

Never automatically send.

---

## Knowledge suggestions

Search attached agent knowledge.

Show relevant citations/source titles.

---

## Next best action

Recommend:

```text
verify identity
check order
open dispute
request additional information
escalate supervisor
transfer queue
resolve
```

Only suggest actions actually available to the system.

---

## Tool assistance

Where the operator has permission:

- suggest relevant tools
- optionally pre-fill tool parameters
- require operator confirmation for mutating actions
- record tool usage

Do not let copilot bypass AgentConnect tool permissions.

---

## Conversation summary

Allow on-demand refresh.

---

## Customer sentiment

Show as supporting context, not as an unquestionable fact.

---

## Similar history

If previous conversations/support cases are legally and operationally accessible within tenant/workspace boundaries, surface relevant prior cases.

Do not violate tenant isolation.

---

# 34. INTERNAL NOTES

Operators must be able to add internal notes.

Internal notes:

- visible to support staff with permission
- invisible to customer
- excluded from normal customer chat rendering
- may optionally be included in AI copilot context
- should NOT automatically become AI customer-facing context unless policy permits

Audit creation.

---

# 35. OPERATOR STATUS

Human Support UI should allow operator presence:

```text
Available
Busy
Away
Do Not Disturb
Offline
```

Optional automatic behavior:

```text
at capacity → Busy
heartbeat lost → Offline
```

Use reasonable presence TTL.

Do not depend purely on browser UI state forever.

---

# 36. HUMAN JOIN EXPERIENCE

When an operator accepts/joins:

Customer UI should display a system event such as:

```text
A support specialist has joined the conversation.
```

Optionally display operator first/display name depending on workspace policy.

Do not expose internal user information unnecessarily.

---

# 37. AI CONTROL DURING HUMAN SESSION

Critical invariant:

```text
conversation_mode = human
```

means:

AI runtime may:

- summarize
- retrieve knowledge
- provide copilot assistance
- perform explicitly approved background assistance

AI runtime may NOT:

- autonomously send customer messages
- start competing agent responses
- mutate conversation state without policy
- execute customer-facing actions automatically unless explicitly permitted

Maintain transactional protection against race conditions.

---

# 38. CUSTOMER MESSAGE DURING HUMAN SESSION

Customer message:

```text
→ canonical conversation timeline
→ operator UI
→ support case
```

It must not automatically trigger normal autonomous agent response while human controls conversation.

---

# 39. OPERATOR MESSAGE

Operator reply:

```text
→ canonical conversation-visible message
→ customer channel
→ support case event
→ analytics
```

Future channels such as WhatsApp must route operator responses through the appropriate channel adapter.

Do not make support replies browser-widget-only architecturally.

---

# 40. RESOLUTION WORKFLOW

Operator selects:

```text
Resolve
```

Require optional/required fields according to workspace settings:

```text
resolution code
resolution note
customer-visible final response
internal resolution summary
```

Resolution codes examples:

```text
resolved
information_provided
action_completed
transferred_external
duplicate
customer_left
unable_to_resolve
invalid_request
```

Make codes configurable later if practical.

---

# 41. AI RETURN CONTEXT

This is mandatory.

When case resolves, create a structured `ai_resume_context`.

Example:

```json
{
  "caseId": "...",
  "issue": "Unauthorized card transaction",
  "resolution": "Card blocked and dispute opened",
  "actionsCompleted": [
    "Blocked card ending 8944",
    "Created dispute DSP-29219",
    "Issued temporary credit"
  ],
  "references": {
    "disputeId": "DSP-29219"
  },
  "expectedNextStep": "Review within 5-7 working days",
  "doNotRepeat": [
    "Identity verification",
    "Card blocking",
    "Dispute creation"
  ]
}
```

Validate with schema.

---

# 42. HUMAN → AI RESOLUTION SUMMARY

Before AI resumes:

```text
Human conversation
       ↓
Resolution summarizer
       ↓
Structured resume context
       ↓
Validation
       ↓
Persist
       ↓
AI control restored
```

If summarization fails:

- do not lose resolution
- use deterministic fallback from operator-provided resolution fields
- AI may resume with fallback context

Never make successful resolution dependent on LLM availability.

---

# 43. AI RESUME BEHAVIOR

After human exits:

```text
conversation_mode = returning_to_ai
```

System incorporates approved resolution context.

Then:

```text
conversation_mode = ai
```

The next AI turn must have access to:

- prior AI conversation
- customer-visible human messages where policy permits
- structured resolution context
- completed action identifiers
- do-not-repeat actions

Do not dump unlimited support history into every future prompt.

Use structured summaries to control token growth.

---

# 44. CUSTOMER EXPERIENCE AFTER RETURN

Customer should receive a subtle state message if useful:

```text
You're back with the AI assistant. I have the resolution from the support specialist and can continue helping you.
```

Avoid awkward:

```text
New session started.
```

because it is not a new session.

---

# 45. CASE REOPENING

If customer immediately says:

```text
That didn't fix it.
```

policy may:

```text
reopen same recently resolved case
```

within a configured short period.

After longer periods, create a new support case linked to the same conversation.

Track reopen count.

---

# 46. SUPPORT POLICY CONFIGURATION

Create workspace/agent/deployment-level policy configuration.

Suggested settings:

```text
humanSupportEnabled

humanEntryMode:
disabled
always_visible
policy_controlled

explicitRequestThreshold

maxAIResolutionAttempts

loopDetectionEnabled

sentimentEscalationEnabled

toolFailureEscalationEnabled

toolFailureThreshold

agentCanRequestHandoff

allowAIDuringQueueWait

defaultQueueId

defaultPriority

routingMode

operatorAcceptanceRequired

operatorAcceptanceTimeoutSeconds

showOperatorNameToCustomer

requireResolutionCode

generateHandoffSummary

generateResolutionSummary

aiCopilotEnabled

returnToAIEnabled
```

Use validated schemas.

---

# 47. POLICY PRECEDENCE

Define deterministic precedence.

Recommended:

```text
Workspace defaults
      ↓
Agent override
      ↓
Deployment/channel override
```

Never produce ambiguous merged configuration.

---

# 48. BUSINESS HOURS

Queues may have schedules.

Support:

```text
timezone
weekday schedules
holiday override later
```

When queue unavailable:

Configurable behavior:

```text
continue_with_ai
collect_message
create_offline_case
route_to_fallback_queue
show_business_hours
```

---

# 49. SLA POLICY

Create support SLA configuration.

Possible fields:

```text
first_response_target_seconds
assignment_target_seconds
resolution_target_seconds
warning_threshold_percent
```

Track:

```text
on_track
warning
breached
```

SLA timers should account for case states according to policy.

Example:

```text
waiting_customer
```

may pause resolution SLA if configured.

---

# 50. PRIORITY

Support:

```text
low
normal
high
urgent
```

Priority may come from:

- default queue policy
- deterministic business rule
- AI triage recommendation
- operator
- supervisor

AI should not silently promote everything to urgent.

Persist reason for priority changes.

---

# 51. NOTIFICATIONS

Initial implementation should support in-app notification primitives.

Events:

```text
new case
case assigned
assignment request
SLA warning
SLA breach
customer replied
case transferred
```

Architect for later:

```text
email
Slack
Teams
push
webhook
```

Do not block initial implementation on all external notification channels.

---

# 52. REAL-TIME DELIVERY

The current five-second polling model should not be the final operator experience.

Prefer:

```text
SSE
```

or WebSocket where true bidirectional real-time behavior is justified.

Customer and operator messages should appear promptly.

Provide reconnect strategy.

Polling may remain as fallback.

---

# 53. RBAC

Do not create unrelated authorization logic.

Integrate with existing workspace RBAC.

Introduce permissions conceptually similar to:

```text
support:view
support:reply
support:claim
support:assign
support:transfer
support:resolve

support:queue:view
support:queue:manage

support:operator:view
support:operator:manage

support:policy:view
support:policy:manage

support:analytics:view

support:supervise
```

Map existing `handoff:manage` permissions during migration.

---

# 54. ROLE EXPECTATIONS

Conceptually:

### Operator

Can:

- view assigned/eligible cases
- claim where allowed
- reply
- use copilot
- add notes
- resolve
- transfer where allowed

### Supervisor

Additionally:

- view all queue cases
- manually assign
- override assignments
- change priority
- transfer any case
- monitor operators
- manage SLA exceptions

### Workspace Admin

Additionally:

- configure queues
- configure operators
- configure policies
- configure routing

### Analyst

Read-only support analytics and permitted conversation context.

---

# 55. SECURITY

All support records must carry:

```text
organization_id
workspace_id
```

Enforce tenant isolation on every query.

Never rely solely on case/conversation IDs.

Guest/customer authorization must remain scoped to their conversation/deployment/channel identity.

Operator access must require authenticated workspace membership and relevant permission.

---

# 56. AUDIT

Audit:

```text
case creation
assignment
claim
transfer
priority change
queue change
operator join
operator leave
resolve
reopen
policy modification
queue modification
operator profile modification
```

Do not copy complete customer support message bodies into general audit logs.

Message records themselves remain the content source.

---

# 57. DATA RETENTION

Prepare support data for workspace retention policies.

Support:

- cases
- messages
- summaries
- internal notes
- routing metadata
- analytics

Do not implement irreversible hard-delete behavior without considering conversation retention and audit requirements.

---

# 58. CHANNEL ABSTRACTION

Human Support must work independently of specific channels.

Initial:

```text
hosted chat
website widget
playground if useful
```

Future:

```text
WhatsApp
Messenger
Teams
Slack
voice
SMS
mobile SDK
```

The support domain must not assume browser-only guest tokens for operator messaging.

---

# 59. VOICE FUTURE COMPATIBILITY

Do not fully implement contact-center voice unless already in scope.

However architecture must permit:

```text
AI voice
→ human voice transfer
→ human leaves
→ AI voice resumes
```

SupportCase should therefore be channel-neutral.

---

# 60. ANALYTICS

Create Human Support analytics.

Core metrics:

## AI containment rate

```text
conversations resolved without human
/
eligible AI support conversations
```

---

## Handoff rate

```text
conversations requiring human
/
eligible conversations
```

---

## Deflection

Track reduction in human-handled conversations relative to configured business baseline where meaningful.

Do not fabricate savings without configured baseline.

---

## Handoff reason

Break down:

```text
explicit request
AI unable to resolve
tool failure
business rule
sentiment
restricted action
manual
other
```

---

## Queue metrics

```text
cases created
cases resolved
current backlog
average wait time
P50/P95 wait time
assignment time
first response time
resolution time
SLA breach rate
```

---

## Operator metrics

```text
cases handled
active cases
average handling time
first response time
resolution rate
transfer rate
reopen rate
copilot usage
```

Avoid simplistic ranking that encourages bad operator behavior.

---

## AI → Human quality

Track:

```text
handoff summary generated
summary usefulness feedback later
operator time-to-first-action
number of repeated questions after handoff
```

---

## Human → AI quality

Track:

```text
return-to-AI count
successful continuation
re-escalation rate
reopen rate
AI repeated completed action
```

---

# 61. CUSTOMER SATISFACTION

Prepare optional post-resolution CSAT.

Example:

```text
How was your support experience?

1 2 3 4 5
```

Do not make it mandatory for core implementation.

Store separately from model evaluation.

---

# 62. SUPERVISOR VIEW

Provide:

```text
queue backlog
active operators
operator presence
operator capacity
unassigned cases
SLA warning
SLA breached
urgent cases
```

Supervisor should be able to:

```text
assign
reassign
transfer
change priority
join/read case
```

Optionally allow supervisor takeover later.

---

# 63. QUEUE SETTINGS UI

Human Support → Settings → Queues.

Allow:

```text
Create queue
Rename
Enable/disable
Routing strategy
Operators
Skills
Languages
Capacity behavior
SLA
Business hours
Fallback queue
Priority defaults
AI triage settings
```

---

# 64. OPERATOR SETTINGS UI

Human Support → Settings → Operators.

Show workspace users.

Allow enabling support role/profile.

Configure:

```text
queues
skills
languages
capacity
routing weight
```

Do not duplicate authentication accounts.

---

# 65. SUPPORT POLICY UI

Human Support → Settings → Handoff Policy.

UI should explain behavior plainly.

Example:

```text
Human support

Human access:
● AI-controlled
○ Always visible
○ Disabled

Offer human support when:
☑ Customer asks repeatedly
☑ AI fails to resolve after 2 attempts
☑ Tool fails repeatedly
☑ Policy requires manual support

AI may request escalation:
☑ Enabled

After human resolution:
☑ Return conversation to AI

AI copilot for operators:
☑ Enabled
```

---

# 66. AGENT-SPECIFIC SUPPORT SETTINGS

Agents should optionally override workspace defaults.

Example:

```text
Sales Agent
→ Sales queue

Banking Support Agent
→ Banking queue

Technical Agent
→ Technical queue
```

Allow intent routing within each agent.

---

# 67. SUPPORT CASE API

Design REST resources around domain objects rather than a single overloaded action endpoint.

Conceptually:

```text
GET    /workspaces/:workspaceId/support/cases
POST   /workspaces/:workspaceId/support/cases

GET    /workspaces/:workspaceId/support/cases/:caseId

POST   /support/cases/:caseId/claim
POST   /support/cases/:caseId/assign
POST   /support/cases/:caseId/accept
POST   /support/cases/:caseId/reject
POST   /support/cases/:caseId/transfer

POST   /support/cases/:caseId/messages
POST   /support/cases/:caseId/notes

POST   /support/cases/:caseId/resolve
POST   /support/cases/:caseId/reopen

GET    /support/cases/:caseId/events

POST   /support/cases/:caseId/copilot/suggest
POST   /support/cases/:caseId/copilot/summarize
```

Exact routes may follow existing repository conventions.

Document via OpenAPI.

---

# 68. QUEUE API

Conceptually:

```text
GET    /workspaces/:workspaceId/support/queues
POST   /workspaces/:workspaceId/support/queues
GET    /support/queues/:queueId
PATCH  /support/queues/:queueId
DELETE /support/queues/:queueId
```

Prefer disable/archive to destructive deletion when referenced historically.

---

# 69. OPERATOR API

Conceptually:

```text
GET   /workspaces/:workspaceId/support/operators
GET   /support/operators/:userId
PATCH /support/operators/:userId

POST /support/operators/:userId/presence
```

---

# 70. POLICY API

Conceptually:

```text
GET /workspaces/:workspaceId/support/policy
PUT /workspaces/:workspaceId/support/policy
```

Agent/deployment overrides through relevant existing resources where appropriate.

---

# 71. PUBLIC CUSTOMER API

Customer-facing support APIs must remain narrowly scoped.

Operations include:

```text
request support
confirm escalation
send support message
cancel request where allowed
view support status
receive support messages/events
```

Do not expose:

```text
queues
operator roster
routing scores
internal notes
copilot suggestions
internal SLA
```

---

# 72. DATABASE MIGRATION

Create a new migration after current latest migration.

Do not modify old migrations already applied.

Migrate current open handoffs into `support_cases`.

Suggested strategy:

For every conversation where:

```text
handoff_status != none
```

create historical support case representing current/previous handoff.

Map:

```text
pending  → queued
active   → active
resolved → resolved
```

Preserve original `handoff_events`.

Either:

1. migrate them into generalized `support_events`, or
2. support legacy read path temporarily and migrate later.

Prefer actual migration if safe.

---

# 73. BACKWARD COMPATIBILITY

Current client handoff routes should either:

- continue working through an adapter layer, or
- be intentionally migrated together with every first-party client

No broken widget deployments.

No silent loss of existing handoff records.

---

# 74. SERVICE ORGANIZATION

Refactor support logic out of the oversized channels module.

Suggested organization:

```text
apps/api/src/support/

cases.ts
queues.ts
operators.ts
policies.ts
routing.ts
triage.ts
assignment.ts
presence.ts
messages.ts
resolution.ts
copilot.ts
analytics.ts
permissions.ts
events.ts
types.ts
```

Follow existing repository architecture where another organization is more consistent.

The key requirement is separation of concerns.

---

# 75. SHARED SCHEMAS

Add support schemas under the existing schemas package.

For example:

```text
packages/schemas/src/support.ts
```

Include:

```text
SupportCaseStatus
ConversationMode
SupportPriority
RoutingMode
OperatorPresence
SupportPolicy
QueueConfig
AssignmentRequest
TransferRequest
ResolutionRequest
AITriageResult
AIHandoffSummary
AIResumeContext
```

Use Zod.

Reuse schemas server/client where appropriate.

---

# 76. AI PROVIDER NEUTRALITY

Do not implement support intelligence specifically for OpenAI.

Use AgentConnect's existing provider/model abstractions.

Allow workspace-configured model selection for:

```text
triage
summary
copilot
resolution summary
```

Provide sane fallback to normal agent model where configuration absent.

---

# 77. TOKEN/COST CONTROL

AI support functions can create hidden cost.

Record usage separately where possible:

```text
support_triage
handoff_summary
copilot_reply
resolution_summary
```

Avoid unnecessary regeneration.

Cache/store generated summaries.

---

# 78. FAILURE HANDLING

The support system must function even if AI provider is unavailable.

Examples:

AI triage fails:

```text
→ route default queue
```

AI summary fails:

```text
→ operator still receives raw conversation
```

AI copilot fails:

```text
→ operator can still reply manually
```

AI resolution summary fails:

```text
→ deterministic operator resolution data used
```

Human support must not depend entirely on AI services.

---

# 79. CONCURRENCY

Protect against:

```text
two operators claiming same case
AI starting while human owns conversation
operator resolving while another message writes
case transferred while old operator replies
duplicate assignment jobs
duplicate escalation requests
```

Use:

- database transactions
- row locks
- unique constraints
- idempotency where appropriate

Redis locks may assist but PostgreSQL state is authoritative.

---

# 80. IDEMPOTENCY

Critical actions should be safe against retries.

Especially:

```text
support case creation
assignment
claim
resolution
transfer
event creation
channel outbound delivery
```

Do not create duplicate support cases from repeated client retries.

---

# 81. REAL-TIME EVENT MODEL

Define support runtime events such as:

```text
support.case.created
support.case.updated
support.case.assigned
support.case.transferred
support.operator.joined
support.message.created
support.case.resolved
support.ai.resumed
```

Use SSE/WebSocket infrastructure consistently with existing runtime architecture.

---

# 82. CUSTOMER DISCONNECT

If customer disconnects:

Do not immediately discard support case.

Track last customer activity.

Policy may eventually:

```text
wait
mark waiting_customer
auto-close after configured time
```

Avoid implementing aggressive automatic closure without configuration.

---

# 83. OPERATOR DISCONNECT

If operator loses connection:

Do not immediately transfer case.

Presence heartbeat should eventually detect absence.

After timeout:

Possible policy:

```text
keep assigned
return to queue
notify supervisor
```

Choose a sensible initial implementation and document it.

---

# 84. NO AVAILABLE OPERATORS

If no eligible operator:

Case remains queued.

Customer receives truthful status.

Optional:

```text
fallback queue
continue limited AI
collect message
offline support case
```

Never pretend a human is joining when none is available.

---

# 85. QUEUE OVERFLOW

Support configurable behavior:

```text
stay_in_queue
fallback_queue
allow_over_capacity
offline_case
```

Default recommended:

```text
stay_in_queue
```

---

# 86. ASSIGNMENT EXPLAINABILITY

For AI-assisted/hybrid routing store:

```text
selected operator
candidate score
skill match
language match
workload
queue
routing strategy
```

Supervisor UI can optionally show:

```text
Why this operator?
```

Example:

```text
Burmese language match
Card dispute expertise
1/5 active capacity
Member of Card Disputes queue
```

---

# 87. PRIORITY SAFETY

Priority should be deterministic where possible.

AI may recommend.

Business rules/operator/supervisor make authoritative result according to policy.

---

# 88. CUSTOMER IDENTITY

Do not require authenticated customer identity.

Support:

```text
authenticated user
guest widget visitor
future messaging identity
future voice identity
```

Support case always references conversation.

Conversation remains identity abstraction boundary.

---

# 89. MESSAGE MODEL

Where technically practical, evolve toward a unified conversation event/message model that can identify:

```text
role/customer
role/assistant
role/operator
role/system
```

Do not perform an unnecessary risky rewrite solely for aesthetics.

Migration safety takes priority.

---

# 90. CUSTOMER-VISIBLE OPERATOR IDENTITY

Configurable:

```text
anonymous:
"Support Specialist"

first_name:
"Thiri"

display_name:
"Thiri — Customer Support"
```

Never expose email address or internal account identifiers by default.

---

# 91. INTERNAL VS PUBLIC DATA

Every support datum should be clearly categorized.

Customer-visible:

```text
customer messages
AI messages
operator replies
selected system status messages
```

Internal:

```text
routing explanation
AI confidence
internal notes
operator assignment details
SLA
copilot suggestions
candidate scores
supervisor actions
```

Ensure public APIs cannot leak internal fields.

---

# 92. TESTING REQUIREMENTS

Add comprehensive automated tests.

## Unit/domain tests

Cover:

```text
state transitions
routing eligibility
routing scoring
capacity
skill matching
language matching
priority
policy evaluation
resolution context generation
fallback behavior
```

---

## API integration tests

Cover:

```text
create escalation
duplicate escalation
claim race
assign
accept/reject
transfer
operator reply
customer reply
resolve
reopen
return AI control
authorization
tenant isolation
guest access
```

---

## Concurrency tests

Specifically test:

```text
two operators claim simultaneously
AI run starts during support activation
resolution and reply race
duplicate support creation
assignment job duplicate
```

---

## Browser/E2E tests

Cover:

```text
customer AI conversation
AI offers human
customer accepts
case enters queue
operator opens panel
operator accepts
customer sees human joined
human replies
customer replies
operator uses copilot
operator resolves
AI resumes
customer continues
AI knows resolution context
```

This should be a flagship E2E scenario.

---

# 93. CRITICAL E2E ACCEPTANCE SCENARIO

Implement this scenario end-to-end.

Customer:

```text
I don't recognize a transaction.
```

AI:

- retrieves relevant information or simulates through test fixture
- attempts resolution
- determines manual support is required
- offers human support

Customer:

```text
Yes, connect me.
```

System:

```text
creates support case
classifies intent = card_dispute
language detected
routes Card Disputes queue
assigns eligible operator
```

Operator:

- receives notification
- sees AI summary
- sees conversation
- accepts case

Customer UI:

```text
A support specialist has joined.
```

Operator sends:

```text
I've reviewed the transaction and created dispute DSP-29219.
```

Operator resolves with structured resolution:

```text
disputeId = DSP-29219
cardBlocked = true
reviewTime = 5–7 working days
```

System:

```text
generates AI resume context
returns controller to AI
```

Customer:

```text
What is my dispute number again?
```

AI must correctly answer:

```text
DSP-29219
```

without redoing the original troubleshooting.

This acceptance test is mandatory.

---

# 94. ANALYTICS ACCEPTANCE

At minimum analytics should calculate correctly:

```text
number of support cases
handoff rate
AI containment rate
average queue wait
average first human response
average handle time
resolution rate
reopen rate
transfer rate
SLA breach count
```

Use SQL/aggregation, not AI-generated analytics.

---

# 95. OBSERVABILITY

Add structured telemetry.

Include where applicable:

```text
trace_id
conversation_id
support_case_id
workspace_id
organization_id
queue_id
operator_id
agent_id
deployment_id
```

Instrument:

```text
triage duration
queue duration
assignment duration
human response duration
support resolution duration
copilot request latency
AI resume generation latency
```

Do not log sensitive message content unnecessarily.

---

# 96. DOCUMENTATION

Update:

```text
README.md
docs/channels-voice.md
docs/product-spec.md
docs/architecture.md
docs/data-model.md
docs/security.md
docs/operations.md
```

Create:

```text
docs/human-support.md
```

Document:

- architecture
- states
- queues
- routing
- operator profiles
- policies
- AI escalation
- copilot
- AI return
- permissions
- API usage
- limitations
- local testing

---

# 97. LOCAL DEVELOPMENT

Provide seed/dev setup sufficient to test:

```text
3 queues
4 operators
different skills
different languages
different capacity
```

Example:

```text
General Support

Billing

Card Disputes
```

Operators:

```text
Alice
skills: billing
language: en

Bob
skills: technical
language: en

Thiri
skills: card_dispute, fraud
languages: my, en

Max
skills: billing, card_dispute
languages: de, en
```

Make manual testing straightforward.

---

# 98. UI QUALITY

This is an enterprise operational surface.

Avoid prototype-like UI.

Required:

- loading states
- empty states
- error states
- accessible controls
- keyboard usability
- responsive layout
- timestamps
- clear operator/customer/AI distinction
- confirmation where destructive/important
- optimistic updates only when safe
- real-time state synchronization

---

# 99. PERFORMANCE

Avoid loading entire conversation/support histories unbounded.

Use pagination.

Examples:

```text
cases: cursor pagination
messages/events: cursor pagination
analytics: bounded date ranges
```

Do not retain current prototype limits as the permanent scalability model.

---

# 100. INDEXING

Add appropriate DB indexes.

Likely important combinations include:

```text
workspace_id + status
workspace_id + queue_id + status
workspace_id + assigned_operator_id + status
workspace_id + priority + status

conversation_id
support_case_id + created_at

queue_id + status + created_at

assigned_operator_id + status
```

Inspect query plans for high-frequency queries.

---

# 101. DATABASE CONSTRAINTS

Use relational constraints.

Examples:

```text
support case belongs to same workspace/org as conversation

queue belongs to same workspace

assigned operator must belong to workspace

queue membership must be tenant consistent
```

Do not rely solely on application code.

---

# 102. ARCHITECTURAL INVARIANTS

These must always hold.

### Invariant 1

One conversation has at most one actively open customer-facing support case unless explicitly designed otherwise.

### Invariant 2

When human controls conversation, autonomous AI cannot send customer-facing messages.

### Invariant 3

Human resolution cannot destroy previous AI context.

### Invariant 4

Returning to AI does not create a new conversation.

### Invariant 5

Support messages survive server restart.

### Invariant 6

Operator/copilot internal content never leaks through public endpoints.

### Invariant 7

All support resources are tenant scoped.

### Invariant 8

Assignment is concurrency-safe.

### Invariant 9

AI provider failure does not make human support unavailable.

### Invariant 10

The customer cannot choose arbitrary internal queue/operator IDs through public API.

---

# 103. NON-GOALS FOR INITIAL RELEASE

Do not over-expand the first implementation into:

- full telephony/ACD
- workforce scheduling
- payroll
- employee performance scoring
- external Zendesk replacement import
- complex omnichannel campaign system
- advanced forecasting
- speech recording
- call recording
- full CRM

Keep architecture extensible but finish the core support experience first.

---

# 104. IMPLEMENTATION PHASES

Implement incrementally, but keep the final architecture in mind.

## Phase A — Support domain foundation

Implement:

- support_cases
- support_events
- support queues
- conversation controller/mode
- backwards migration
- RBAC
- basic API
- state machine

Do not proceed until tests pass.

---

## Phase B — Human Support Console

Implement:

- new top-level Human Support section
- case list
- queue filters
- conversation timeline
- claim
- assign
- operator reply
- internal notes
- resolve
- return to AI

---

## Phase C — Operators and routing

Implement:

- operator profile
- presence
- capacity
- skills
- languages
- queue membership
- round robin
- least loaded
- skill routing
- hybrid routing

---

## Phase D — AI triage and intelligent escalation

Implement:

- policy-controlled human access
- loop detection
- explicit-request policy
- agent-requested escalation
- tool failure escalation
- structured AI triage
- AI handoff brief

---

## Phase E — Operator AI Copilot

Implement:

- suggested reply
- summary
- relevant knowledge
- suggested next action
- tool recommendation
- safe failure behavior

---

## Phase F — Human → AI continuity

Implement:

- structured resolution
- AI resume context
- controlled transition back to AI
- no-repeat context
- E2E continuation test

This is mandatory before declaring Human Support complete.

---

## Phase G — Operational maturity

Implement:

- SLA
- business hours
- notifications
- supervisor dashboard
- analytics
- transfers
- assignment acceptance/timeouts
- realtime event delivery improvements

---

# 105. MIGRATION FROM CURRENT HANDOFF UI

Replace the existing simplistic customer behavior:

```text
Human Support
Request human support
```

with policy-driven presentation.

Do not delete all existing UI immediately.

Adapt it so:

```text
humanEntryMode = always_visible
```

can reproduce legacy behavior.

For default:

```text
humanEntryMode = policy_controlled
```

the UI should only present escalation when triggered/offered.

---

# 106. LEGACY HANDOFF ACTIONS

Current actions such as:

```text
request
claim
message
reply
resolve
```

should map to new domain operations during transition.

Avoid maintaining two independent implementations.

Use compatibility adapters calling the new Support service.

---

# 107. CODE QUALITY REQUIREMENTS

Follow existing:

- TypeScript strictness
- monorepo conventions
- Fastify conventions
- Zod schemas
- SQL/migration conventions
- test organization

Do not introduce a second ORM/framework just for this module.

Do not hard-code queue names, role names or provider names.

Avoid god files.

Avoid circular dependencies.

---

# 108. CODEX EXECUTION INSTRUCTIONS

Before coding:

1. Read the entire relevant existing implementation.
2. Inspect current database schema.
3. Inspect current migrations.
4. Inspect current RBAC model.
5. Inspect current agent conversation/run locking.
6. Inspect current widget/public auth.
7. Inspect existing operations analytics patterns.
8. Inspect tests.

Then produce a short internal implementation plan.

Do NOT ask me to redesign existing architecture unless there is a genuine blocker.

Prefer extending existing conventions.

Do not remove working features solely because the new design is cleaner.

Maintain migration compatibility.

---

# 109. REQUIRED VALIDATION BEFORE COMPLETION

Run at minimum the project's relevant:

```text
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Run appropriate E2E/browser tests.

Add any new migration/setup steps to documentation.

Do not report completion if:

- migration fails
- typecheck fails
- tests fail
- build fails
- legacy widget support breaks
- AI can respond while human owns the conversation
- human resolution is forgotten after AI resumes

---

# 110. DEFINITION OF DONE

This feature is considered complete only when the following real-world flow works:

```text
1. Customer starts with AI.

2. Customer does not see an unrestricted human button by default.

3. AI attempts to resolve the issue.

4. Escalation policy determines that human support is appropriate.

5. Customer is offered human support.

6. Customer accepts.

7. A durable Support Case is created.

8. AI triage determines issue/category/language/priority/skills.

9. Correct support queue is selected.

10. Eligible operator is determined.

11. Assignment occurs according to queue policy.

12. Operator receives the case.

13. Operator sees:
    - full conversation
    - AI handoff summary
    - customer context
    - prior actions
    - suggested next action.

14. Operator accepts/joins.

15. AI stops customer-facing responses.

16. Customer sees that a human has joined.

17. Customer and human continue in the same conversation.

18. AI remains available privately as operator copilot.

19. Operator can:
    - send messages
    - add internal notes
    - use AI suggestions
    - use approved tools
    - transfer
    - resolve.

20. Operator resolves case.

21. Resolution is converted into validated structured context.

22. AI gains the human resolution context.

23. Conversation control returns to AI.

24. Customer remains in the same chat.

25. Customer asks a follow-up.

26. AI knows what the human did.

27. AI does not repeat already completed steps.

28. Conversation may later escalate again into another Support Case.

29. All routing/assignment/resolution events are auditable.

30. Analytics reflect the full AI → Human → AI lifecycle.
```

---

# 111. PRODUCT PRINCIPLE TO PRESERVE

The final architecture must embody this:

```text
         ┌─────────────── AI ───────────────┐
         │                                   │
Customer ─── Conversation ─── Support Case ─── Human
         │                                   │
         └─────────────── AI ◄───────────────┘
```

The Conversation belongs to the customer journey.

The Support Case belongs to the temporary human intervention.

The AI Agent and Human Operator are alternate controllers of the same customer conversation.

Human handoff must therefore not mean:

```text
AI conversation terminated
```

It means:

```text
AI customer-facing control temporarily suspended.
```

When the human finishes:

```text
resolution captured
→ context preserved
→ AI control restored
```

That is the core design requirement.

---

# 112. FINAL PRODUCT OUTCOME

The implemented AgentConnect Human Support module should function as:

```text
AI Customer Service
        +
Intelligent Escalation
        +
Human Routing
        +
Live Support Inbox
        +
AI Operator Copilot
        +
Human-to-AI Continuity
        +
Contact Center Analytics
```

rather than merely:

```text
Chatbot + "Talk to human" button
```

The business objective is not to eliminate humans.

The business objective is:

```text
Automate what AI can solve
        ↓
Recognize what AI cannot solve
        ↓
Route intelligently to the right human
        ↓
Make that human significantly more productive with AI
        ↓
Return routine follow-up back to AI
```

Implement the feature according to this specification while preserving AgentConnect's existing provider-neutral, multi-tenant, schema-driven and enterprise-oriented architecture.