# Banking core AI configuration

These features reuse Agent drafts, versions, deployments and workspace knowledge. Apply migration `0024_bank_core_ai.sql` with `pnpm db:migrate` before starting the updated API and worker.

## Review and publish knowledge

In Knowledge → Settings, a workspace administrator can require approval. In Releases, select ready sources and create a frozen draft, inspect its passages, then submit it for review. A different administrator with `knowledge:approve` approves or rejects it, recording a review note. Publish an approved release to make it current. Publishing a previous published release restores it without changing its content. Editing or reindexing a live source does not alter a frozen release.

Agent Configure → Knowledge can follow the current published release or pin an attached knowledge base to a particular published release. Pinned releases remain stable through subsequent publication. Approval-required bases never retrieve unpublished live content. Source deletion, archive and public-access restrictions still apply at retrieval time; release snapshots are not a bypass for those restrictions. History retains private review provenance until retention/deletion removes its records.

A release supports up to 100 selected sources and 5,000 passages. The review preview shows its first 100 passages, and the history lists the latest 100 releases. Builders can prepare and submit drafts; approval and publication require administrator permission. Unattached, unpublished or unavailable pins are rejected when saving/publishing/deploying.

## Grounded answers and clarification

Agent Configure → Knowledge → Answer policy enables approved-knowledge-only answers. This selects approved retrieval, always retrieves attached knowledge, and requires citations. Rich response generation and model-planned tool calls are excluded from this mode so factual answers use reviewed passages. Standard mode retains existing tool and knowledge usage policies.

The model returns an answer, a focused clarification, or no answer. Answers are buffered and checked for valid citation references before display. Missing references and malformed responses fail safely; an empty retrieval returns the configured friendly no-answer response without invoking the model. Citation validation establishes referenced passages, not proof that every claim is entailed; review answers with the existing quality evaluation workflow before public release.

Configure the no-answer text and optional human offer here. Human support must also be enabled in the existing handoff policy. Existing business hours, availability and customer consent apply; requesting customer care does not bypass them.

## Quick actions and support journeys

Agent Configure → Experience includes a structured quick-action editor. Each action has a separate label and message and can send a message, populate the composer, start a journey, or offer customer care. Up to 20 actions and 12 journeys are supported. Existing conversation starters continue to work. Hosted chat, Playground and the embedded widget render the same versioned configuration.

“Add banking templates” adds eight editable actions, including password recovery, login trouble, device changes, transfer issues and customer care. The four journey templates collect a small sequence of investigation facts. Each field has a stable key, label and question; completion either requests guidance from the agent or offers handoff. Configure these questions to match your actual support procedures. They do not verify identities, reset passwords or execute banking transactions.

Journey progress is persisted with completed conversation turns and retained in the transcript passed to existing support handoff and brief generation. Customers can send `/cancel`. Selecting a different send action exits an active journey; selecting another journey starts that journey. Populate actions only fill the composer until the customer submits. Templates warn against sharing passwords, PINs, OTPs and full account/card numbers; basic sensitive-value rejection is not a comprehensive data-loss-prevention system.

Save the draft, test in Playground, then publish and deploy through the existing lifecycle. Existing conversations use their original configuration snapshot; start a new conversation to test changed settings.

## Verification

`apps/api/test/bank-core-ai.test.ts` covers tenant permissions, independent review, release pinning/rollback, frozen retrieval, grounding/clarification/no-answer, customer consent, journey state and shared workflow execution. `tests/browser/bank-core-ai.spec.mjs` exercises the review UI, draft configuration, hosted guidance and widget transfer handoff with isolated local provider fixtures.

Validated on 2026-10-11: all 336 API tests passed (including 17 new banking-core tests), the banking browser scenario passed, all eight workspace build/typecheck tasks passed, lint passed, and repeat migration application succeeded. Provider responses in these checks are controlled fixtures; bank acceptance with actual content and provider credentials remains separate.
