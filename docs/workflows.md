# Visual workflows

Phase 4 provides a workspace-scoped canvas and a durable LangGraph runner. Start PostgreSQL and the worker alongside the API and web app; `pnpm db:migrate` applies migration 0005. The runtime creates its PostgreSQL checkpoint tables in `workflow_checkpoints` on first use. Temporal remains development infrastructure; this slice runs LangGraph directly with PostgreSQL leases and checkpoints.

## Build and run

1. Register models, create agents, and publish their configurations in Agents. Workflow Agent nodes reference a specific published version, including its model snapshot and prompt.
2. Open Workflows, create a workflow, and name it. Use the two-agent review template or add nodes and connect their handles. Drag to position nodes; use pan/zoom, minimap, auto-layout, undo/redo, duplicate, and keyboard copy/paste. Shift-select copies a group and its internal edges.
3. Select nodes to configure published agents, reviewed tools, branch predicates, approval prompts, or input mappings. Save the graph, validate its dependencies, and publish an immutable version. Invalid drafts can be saved; publication and execution require a valid graph.
4. Enter an input and run either the saved draft or a published version. The inspector shows the immutable run graph, node inputs/outputs, durations, provider-reported token usage, citations, tool traces, and final output.
5. At a Human Approval node, an administrator or operator can approve, reject, or replace the input with a JSON value and add a comment. Approval resumes the persisted checkpoint; completed upstream agents do not run again. A builder can cancel an active run.

Published versions can be restored into a new draft revision. Restoration and later edits leave existing versions and run snapshots intact. Archived agents, revoked tools, disabled connectors, and missing credentials are checked at execution time. Attached knowledge uses current ready documents, as in the single-agent runtime.

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
