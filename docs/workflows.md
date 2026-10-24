# Visual workflows

Phase 4 provides a workspace-scoped canvas and a durable LangGraph runner. Start PostgreSQL and the worker alongside the API and web app; `pnpm db:migrate` applies migration 0005. The runtime creates its PostgreSQL checkpoint tables in `workflow_checkpoints` on first use. Temporal remains development infrastructure; this slice runs LangGraph directly with PostgreSQL leases and checkpoints.

## Build and run

1. Register models, create agents, and publish their configurations in Agents. Workflow Agent nodes reference a specific published version, including its model snapshot and prompt.
2. Open Workflows and choose **Create workflow**. The optional three-step wizard asks for a name and starter template, the published agents required by that template, then a canvas preview and review. **Create draft** saves the configured graph. Experienced users can choose **Open canvas directly** instead.
3. In **Build**, select nodes to edit their settings, open **＋ Add nodes** inside the canvas and choose grouped node types. Click to insert after the selected step, or drag a type onto the canvas to place a single unconnected node on the drawing grid. Connect its handles to complete the flow. Common settings appear first; instruction overrides, input mapping and failure recovery are collapsed. Help icons support hover, focus and tap. Drag to position nodes; use pan/zoom, minimap, auto-layout, undo/redo, duplicate and keyboard copy/paste. Shift-select copies a group and its internal edges.
4. Use **Save draft** in the canvas or the sticky **Save workflow** action and validate dependencies. **Workflow details** lets you name the draft inside the canvas. **Expand canvas** provides a larger drawing workspace; Escape exits and restores focus. The expanded view retains the same unsaved graph, selection and history. **Publish** creates an immutable version; invalid or unsaved drafts cannot publish. Node-specific validation messages select the affected node. Activity changes preserve draft edits; switching workflows or leaving the browser page warns about unsaved changes.
5. Use **Test Workflow** on the canvas (or the **Test** activity) to open the inline input/output panel. Run either the saved draft or a published version. Starting a run immediately locks drawing and editing; approval waits stay locked until resolved or cancelled. Running nodes highlight using persisted execution status, with static highlights for reduced-motion users. Panning and zooming remain available. After a terminal result, use **Return to draft canvas** to edit again. The inspector shows the immutable run graph, node inputs/outputs, durations, provider-reported token usage, citations, tool traces, and final output.
6. At a Human Approval node, an administrator or operator can approve, reject, or replace the input with a JSON value and add a comment. Approval resumes the persisted checkpoint; completed upstream agents do not run again. A builder can cancel an active run.

Published versions can be restored into a new draft revision. Restoration and later edits leave existing versions and run snapshots intact. Archived agents, revoked tools, disabled connectors, and missing credentials are checked at execution time. Attached knowledge uses current ready documents, as in the single-agent runtime.

Input/output nodes use capsule shapes, decisions use diamonds, agents and tools use distinct cards, approvals have a specialist icon and junctions use compact dashed shapes. Labels and icons distinguish types alongside color; execution status remains visible.

## Nodes and data flow

| Node               | Behavior                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Input / Output     | One entry and one exit; the run input is text and the final result is JSON.                                                                 |
| Agent              | Runs the selected published agent with its RAG/tool configuration; optional prefix/suffix surrounds the incoming value.                     |
| Tool               | Executes an enabled, reviewed read-only registry tool with fixed JSON arguments and an optional argument populated from the incoming value. |
| Router / Condition | Chooses the true or false handle using equals, contains, or not-empty. These predicates are deterministic.                                  |
| Parallel / Merge   | Runs two to four branches concurrently and joins their outputs by predecessor node ID.                                                      |
| Human Approval     | Persists a review request and interrupts execution until an authorized decision.                                                            |

By default, nodes consume their predecessor's output. An explicit input mapping may select an ancestor's output. Conditional merges use the selected branch; structured parallel merges wait for every branch, including unequal branch lengths.

## Bounds and remaining work

Graphs are acyclic, with at most 40 nodes, 80 edges, and one approval gate. Parallel branches contain linear Agent/Tool paths to a common Merge; nested fan-out, conditional nodes inside parallel branches, and parallel approval gates are rejected. Runs have a five-minute execution deadline per worker attempt, at most three recovery attempts, four concurrent graph tasks, bounded state/output, and a workspace active-run quota. Approval waiting does not keep a worker occupied.

Recovery is at least once: a process crash between an upstream read and its checkpoint may repeat that read. Workflow tools remain read-only. Checkpoints and traces contain workspace input/output data and need production retention, backup, and access policies. Dedicated cleanup/retention scheduling, editable retries/timeouts, model-cost accounting, richer transforms/code nodes, workflow public deployment, collaborative editing, and live hosted-provider acceptance remain later work.

Tests use explicit local provider fixtures and actual PostgreSQL checkpoints. They establish orchestration and protocol behavior, not acceptance against a hosted model provider.

## Templates, retry policies and customer results

Start from **Assisted answer**, **Reviewed answer** or **Parallel research** in the template picker. These are editable graphs, not simulated services: choose published workspace agent versions before testing or publishing. The existing two-agent review shortcut remains available. **Create reusable copy** starts a new workflow draft from the current saved configuration; it preserves agent/tool selections and retry/result settings without changing the original workflow or its published versions. Unsaved changes require confirmation before replacement.

Agent and read-only tool nodes expose **Failure recovery**. One total attempt (the default for existing and new nodes) disables automatic retries. Configure up to three attempts and an initial delay of 100–10,000 ms. Temporary provider failures marked retryable and HTTP tool 429/5xx or tool timeouts can retry. Authentication, permissions, input/schema validation, unsupported model parameters, disabled tools and rejected approvals stop immediately. Delays double between attempts, capped at ten seconds; cancellation interrupts backoff. Each attempt rechecks current dependencies. Completed upstream nodes are not replayed by this retry policy.

Step retries are distinct from existing lease/checkpoint recovery and provider routing/failover. A recovered, unfinished node can execute again under the existing bounded recovery policy, so the persisted attempt count can exceed the configured attempts for one execution. External read requests and model calls may repeat and incur additional cost; this does not introduce mutating tools. The inspector records attempt counts, sanitized failure codes, duration and whether a retry was scheduled. Token totals report successful completion; provider usage for failed attempts may be unavailable.

Configure the Output node's **Result title**, **Result description** and **Result display**. Automatic display renders ordinary answers as text, objects as labeled fields and arrays of objects as tables (up to 100 displayed rows and 20 columns); full output remains accessible. Plain text and technical JSON are available. Presentation changes reuse the existing stored output and perform no additional model call. Hosted chat, the widget and the staff run inspector use the same result interpretation. Customer workflow details show the configured quick-action name, actual completed steps and temporary retry status; branch-dependent progress does not invent a percentage or count unexecuted paths as completed. Public run details exclude graph snapshots and internal prompts.

Migration **0029** adds node attempt counters, retry history and scheduled retry time. Run `pnpm db:migrate` and restart API, web and worker. Published graph snapshots remain immutable; existing versions receive safe defaults when read.

Nested branching within parallel paths, subworkflow nodes, collaborative editing and additional node types remain later extensions.

## Typed inputs and automation triggers

Select the Input node to define named text, number, boolean or JSON fields, with required flags and defaults. Manual tests generate a form from the selected version; workflows without fields retain text input. The **Triggers** activity configures timezone-aware daily/weekly/custom cron schedules with version pinning, overlap policies, downtime recovery, preview and pause/resume. Operations can issue workflow-scoped REST API keys for idempotent asynchronous invocation and key-bound results. See [workflow triggers](workflow-triggers.md) for API requests, limits, upgrade and troubleshooting.

## Field-level handoffs and canvas inspection

Input mapping can select a nested upstream field or assemble named fields from several ancestors. Tool mappings preserve argument types; legacy complete-output mappings remain compatible. Preview with recorded outputs without executing agents/tools, then test the saved draft. Clicking a run node opens its recorded inputs, outputs, citations, tool executions and status in the canvas panel; a step dropdown offers keyboard access. See [field mapping and inspection](workflow-mapping.md) for paths, snapshots and explicit failure behavior.
