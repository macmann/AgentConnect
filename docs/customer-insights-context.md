# Customer insights, improvement and context controls

This implements the user-defined priorities 6–10. Priority 5, SDK work and Myanmar acceptance are outside this change. Run `pnpm db:migrate` (migrations 0025 and 0026), then restart API, worker and web. `js-tiktoken` is pinned in the API dependency manifest and lockfile; use the normal locked installation workflow.

## 6. Analytics and reports

Operations → Customer insights provides inclusive-from/exclusive-to UTC reports and an Excel workbook. UI date pickers include the whole selected final day. A range supports up to 366 days. Reports contain active conversations, browser customer sessions, workspace users, enquiry categories, knowledge-answer failures, daily trends, AI agent usage and operator presence utilization. Workbook sheets preserve numeric cells and encode text as strings, including formula-looking text.

An active conversation has a retained message or customer/operator support event in the range. Customer identity means a deployment-scoped browser session, not a verified person; anonymous legacy conversations count separately. Playground users are reported separately. Categories use current/final support triage or the selected configured journey; unclassified conversations remain Uncategorized. Busy presence rate is time declared busy divided by time declared available or busy, clipped to presence expiry. It is not handling-time productivity. Historical presence collection begins with these migrations; disabled/manual-unavailable profiles do not accumulate staffed time. Daily series includes zero-activity dates. Agent run counts are usage metrics, not model-server CPU utilization. No AI resolution rate is inferred from containment.

The existing Operations analytics API also accepts `from` and `to` timestamps alongside its rolling `days` option. New endpoints are `/workspaces/:id/operations/insights` and `/insights.xlsx`; both require operations viewing permission. Reports aggregate retained tenant records and limit category, agent and operator lists to 100 groups.

## 7. Knowledge-gap improvement

Operations → Knowledge gaps groups unanswered and poorly reviewed questions using normalized exact text. The most recent 1,000 affected runs are inspected, with up to ten examples per group. Narrow the time range when truncation is reported. Suggestions describe which procedure/FAQ needs review; they do not invent factual corrections or imply semantic clustering.

Add a corrected response to an assistant message in the existing Conversation review flow. A reviewer who can manage knowledge may turn that correction into an editable proposed Q&A draft for an approval-required knowledge base. A different knowledge administrator approves or rejects it, leaving a note on rejection. Approved corrections can become queued unpublished Q&A sources. After indexing, include those sources in the existing knowledge-release review and publication flow. This preserves independent review and prevents corrected text from silently becoming live knowledge. Duplicate review/base proposals and invalid tenant references are rejected.

## 8. Consistent branding

Channels → Website widgets → deployment → Customer branding configures chatbot name, HTTPS logo URL, button color, background, text color and welcome message. This single deployment configuration is used by hosted chat and the widget. It does not require publishing another agent version. A blank name uses the published agent; a blank welcome preserves existing channel greetings. Widget placement, size, theme and origin controls continue to work. The logo loads directly in the customer's browser with no referrer; use a public image URL you control. Choose legible color combinations.

## 9. Persistent customer conversations

Hosted chat and widgets automatically create a deployment/channel-scoped browser session and store its opaque bearer credential locally. The credential expires after 30 days. Refresh and return visits restore the selected conversation, its retained messages and the current public support state. Previous conversations, new chat and older-history controls are available; transcript pages contain up to 200 messages and conversation list pages contain 30 records. Support conversations remain on the existing case rather than creating a new handoff when reopened.

Customers see a notice that others using the browser can reopen history. “Forget this browser session” revokes the credential and old guest grants, removes browser memory and starts fresh. It does not delete workspace records; normal workspace retention still applies. Browser storage failures permit an in-memory session for that visit. Changing browsers, deleting storage or expiration creates a new customer session; this is not verified cross-device identity. Private staff notes, triage metadata, copilot and context summaries are excluded from public history. Tenant/deployment/origin/channel bindings, disabled deployments, archived agents and expired sessions remain enforced.

## 10. Token and context optimization

Agent Configure → Advanced → Token and context controls enables explicit input, history and knowledge passage budgets. Choose OpenAI `o200k_base`, `cl100k_base`, or conservative UTF-8 counting. Text counts use the selected tokenizer; message framing is estimated and providers may serialize prompts differently. Use conservative counting where provider tokenization is unknown. The total input budget must fit alongside the configured output limit. Long history respects the existing turn limit and drops oldest complete turns while preserving the current question; passages exceeding the knowledge budget are excluded.

Optional summarization condenses older completed turns, persists a message boundary and reuses the summary without repeatedly summarizing the same transcript. Summaries are untrusted memory, never approved banking content. They consume provider tokens; failed summary generation retains recent turns, and failed/cancelled chat does not persist a new summary. Normal knowledge/citation safeguards remain in place.

The draft payload preview shows system, history, user input, knowledge, tools, summary, output reservation and remaining capacity. Draft preview counts supplied/example context; actual Playground run diagnostics show component counts and every provider call's measured system/messages/output reservation without exposing credential values. Provider-reported usage and local text counting are distinguished.

Daily quotas apply per authenticated workspace user or anonymous deployment-scoped customer session, at UTC day boundaries. Atomic reservations cover possible answer, knowledge/tool planning, summary and support-decision calls before generation, preventing concurrent requests from oversubscribing quota. Completion returns unused reservation and records provider-reported usage, or local counts when usage is unavailable. Partial failed/cancelled provider responses are charged. Requests without enough reserved capacity return HTTP 429 before generation. An interrupted process can leave a reservation conservatively held until the next UTC day; this avoids freeing capacity for unreported model consumption. Anonymous customers can create another identity by deleting browser storage; this is not a verified-person abuse prevention limit. Background quality/workflow and separately configured support/copilot jobs do not spend a public customer's chat quota.

## Validation

`apps/api/test/customer-insights.test.ts` verifies range/export integrity, tokenizer fitting and failed-call accounting, branding scope, session/history boundaries and revocation, analytics, independent knowledge correction review, observed presence intervals, concurrent quotas and runtime summaries. The banking browser test now additionally verifies branding configuration, report UI, hosted transcript restoration and pending widget support restoration.

Validated on 2026-10-11: all 350 API tests passed, including 14 new customer insights/context tests and the prior 17 banking-core tests.

Protocol fixtures establish application behavior; real bank-content, live-provider tokenizer/usage agreement and representative workload acceptance remain separate checks.
