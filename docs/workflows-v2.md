# Workflow Definition V2 foundation

Workflows are a sub-product of AgentConnect. Agents, Knowledge/RAG, Tools/MCP, model providers, encrypted Secrets, saved Connections, authentication, workspaces and administration remain independently managed modules. Workflows orchestrate those assets; they do not own replacement copies of their configurations. Runs/Operations use the existing history, audit, monitoring and worker services.

## Contracts and execution

```mermaid
flowchart TD
  Canvas[Canvas projection] --> Definition[Workflow Definition V2]
  Config[Definition API / node configuration] --> Definition
  AI[AI workflow proposal] --> Definition
  Definition --> Validator[Strict schema and graph/resource validation]
  Validator --> Adapter[Compiler adapter version 1]
  Adapter --> Runtime[Existing LangGraph runtime]
  Runtime --> Postgres[PostgreSQL leases and checkpoints]
  Runtime --> Agent[Published Agent version]
  Runtime --> Action[Deterministic Action / registered Tool]
  Runtime --> Approval[Durable human approval]
```

The current canvas **previews V2 read-only**. Its existing V1 authoring experience is unchanged. V2 authoring is API-first in this foundation: the definition API and optional AI chain proposals feed the compiler. Full visual editing of typed V2 node configuration is a later increment. The UI marks V2 definitions and prevents copying or saving their projection as a V1 workflow. The compiler API can also be used by future configuration panels and AI assistants without coupling execution to React Flow.

V1 keeps `schemaVersion: 1`, `nodes[].type/data/position`, existing JSON Pointer mappings, legacy workflow-owned agents, conditions, tools, approval, fan-out/merge and retry behavior. Existing published V1 JSON is not rewritten. V2 uses:

- `schemaVersion: 2`.
- `execution.nodes`: semantic node IDs, kinds, labels and discriminated configuration.
- `execution.edges`: control-flow source/target and optional true/false branch.
- `execution.resources`: named references to existing tenant-owned assets.
- `execution.actions`: reusable deterministic invocation definitions referenced by Action nodes.
- `execution.variables`: immutable, typed JSON values for this definition.
- `execution.inputFields`: existing typed input-field contract.
- Optional `editor`: node positions, edge-side choices and viewport. These values do not affect scheduling, mapping or conditions.

V2 publication stores the source definition in the existing immutable `workflow_versions.graph` JSONB column. Queuing compiles it to the existing runtime graph representation with an internal `programV2` artifact containing compiler version 1 and the validated execution program, without editor layout or copied resource configuration. Draft tests use the saved definition/revision. Runs use their queued snapshot; later edits to a draft do not affect them. The existing worker consumes V1 and compiled V2 snapshots through the same queue, LangGraph compiler, saver, retries, leases, cancellation, approval and history infrastructure. There is no second workflow engine.

No database migration or hosted-only service is required. Deploy the API, web and worker from the same release. Existing self-hosted PostgreSQL/pgvector, Redis, object storage, provider allowlists, secret encryption and worker settings remain authoritative.

## Resource references

The named resource map accepts these strict reference shapes:

| Kind                        | Reference                                                     |
| --------------------------- | ------------------------------------------------------------- |
| Agent                       | `{ "kind": "agent", "agentId": "UUID", "versionId": "UUID" }` |
| Knowledge base              | `{ "kind": "knowledge", "id": "UUID" }`                       |
| Registered Tool             | `{ "kind": "tool", "id": "UUID" }`                            |
| MCP server                  | `{ "kind": "mcp", "id": "UUID" }`                             |
| Model/provider registration | `{ "kind": "model", "id": "UUID" }`                           |
| Encrypted secret            | `{ "kind": "secret", "id": "UUID" }`                          |
| Saved enterprise connection | `{ "kind": "connection", "id": "UUID" }`                      |

Agent nodes select an Agent resource name. The version must belong to that agent and the same workspace/organization. Its existing published model snapshot, prompt, KB and Tool attachments remain authoritative. V2 cannot embed an Agent config or override that published version's model/knowledge/tools. KB, model, MCP, saved connection and secret references establish validated resource dependencies; this phase does not introduce separate retrieval/model/connection node executors or expose secret values to expressions. Existing Agent/Tool/MCP configuration continues to define how those resources are used.

The server checks ownership and availability on compile/publication and execution. It also checks current Tool enablement, MCP connection availability, Agent archival, knowledge public policy and Action permissions. Secret values are never serialized into definitions or resolved into the workflow context. Action `connectionId`, when specified, must match the registered Tool's credential reference or MCP server ID. It cannot redirect the operation to another connection. Public workflows retain the existing published Agent/Tool access controls; direct secret/model/MCP/saved-connection dependencies are staff-only.

## Tool versus Action

A **Tool** is a registered capability an Agent/LLM may decide to invoke through the existing planner and usage policy. An **Action** is a deterministic invocation explicitly selected by the workflow designer. Both reuse the same registry and execution policies; Actions do not replace Tools. V2 deterministic integration nodes use `kind: "action"`; legacy V1 `tool` nodes remain supported without renaming or migration.

An Action definition includes `id`, `name`, `connector`, `operation`, `toolId`, optional `connectionId`, input/output JSON Schema assertions, static inputs, mapped inputs, timeout, retry policy, side-effect classification, risk level, idempotency capability and required permissions/scopes. Action nodes select `actionId` and may override mapped inputs. Static inputs are overlaid by mapped defaults, then node mappings. Mappings resolve into typed arguments, and the registry's actual input schema is always enforced as well.

This phase registers two read executors: `agentconnect.tool/execute` and `agentconnect.mcp/execute`. Both invoke an existing reviewed read-only Tool; the MCP executor requires a Tool bound to an existing enabled MCP server. Additional input/output schemas are assertions, not replacements for resource configuration. Bounded schemas reject references, regex patterns and formats; no remote schema fetch occurs. Effective timeouts are bounded by the Action, Tool and workflow deadlines. Required permission checks are authorization requirements, never grants.

Write/delete operations, provider-specific OAuth scope verification and executors that accept idempotency keys are **not implemented**. The compiler rejects those requested guarantees rather than pretending to enforce them. Read retries use the existing retry infrastructure. As with V1, a crash between an upstream read and checkpoint persistence can repeat that read; there is no exactly-once claim. Actions are reusable by multiple nodes within a definition. A shared workspace Action registry and additional connector executors are future increments.

## Typed workflow context

Values use either a literal or an explicit reference:

```json
{ "type": "literal", "value": 10 }
```

```json
{ "type": "reference", "path": "steps.ocr.output.text" }
```

Supported roots are `trigger`, `input`, `steps`, `variables`, `workflow` and `error`. Examples:

- `trigger.body.customer.email`: the normalized invocation input, also available at `input.customer.email`.
- `input.items[0].amount`: a typed array element.
- `steps.extract.output.invoiceNumber`: a completed ancestor step's output.
- `variables.batchSize`: a definition variable.
- `workflow.id`, `workflow.versionId`, `workflow.runId`, `workflow.schemaVersion`: stable run metadata.
- `error.code`, `error.nodeId`: initially null. Error-handler routing is not introduced in this phase; terminal errors continue to appear in the existing run/node traces.

`trigger.type` identifies `manual`, `api`, `schedule` or `customer`, derived from persisted run identity. No HTTP authorization headers, cookie values or secret material enter this context. V2 accepts object input without requiring a form; declared `inputFields` still use existing required/default/type validation. Text input remains supported; JSON text is parsed for typed V2 access. Variables are immutable literals, avoiding concurrent branch mutation semantics.

An optional JSON Pointer selects legacy fields containing slashes, spaces or dots, or structured JSON emitted as Agent text:

```json
{
  "type": "reference",
  "path": "steps.extract.output",
  "pointer": "/invoice~1number"
}
```

References permit own data properties and canonical array indices only. `__proto__`, `constructor`, `prototype`, inherited properties, accessors, arbitrary bracket expressions, function calls and JavaScript are rejected. Paths, depth and value traversal are bounded. Step references must name ancestor outputs; unavailable branch outputs or missing fields fail with `WORKFLOW_REFERENCE_MISSING`. Legacy V1 JSON Pointer resolution remains unchanged.

Conditions use `{ "operator", "left", "right"? }` with expressions. Operators: `equals`, `not-equals`, `contains`, `not-contains`, `greater-than`, `greater-than-or-equal`, `less-than`, `less-than-or-equal`, `empty`, `not-empty`, `true`, `false`. Equality is structural and type-preserving. Contains supports strings and array membership. Ordering requires numbers; boolean tests require booleans. Unary tests omit `right`. Empty means null, empty string, empty array or empty object; zero and false are not empty. No implicit number/string coercion or eval occurs.

## API and example

Existing authenticated workflow endpoints accept a V1 or V2 definition in `graph`:

- `POST /workspaces/:workspaceId/workflows`: create a draft.
- `PUT /workflows/:workflowId`: save `name`, `description`, `graph`, `revision` with existing optimistic concurrency.
- `POST /workflows/:workflowId/validate`, `/publish`, `/runs`: existing validation/publication/execution lifecycle.
- `GET /workflows/:workflowId/definition`: canonical source definition and revision.
- `POST /workspaces/:workspaceId/workflows/compile` with `{ "definition": ... }`: validate graph and resource dependencies; return compiler version and runtime projection without executing anything.

For compatibility, the existing workflow-detail and version-list endpoints return the V2 canvas projection in `draft_graph` / `graph` and include `definitionVersion: 2` plus the canonical `definition`. Direct definition clients should use the definition endpoint. A V1 PUT cannot overwrite an existing V2 draft. Database versions always retain their original source format; restore copies the source, never a projection.

Example of a minimal V2 definition with a typed output reference (replace the Agent UUIDs with existing published assets when adding Agent nodes):

```json
{
  "schemaVersion": 2,
  "execution": {
    "variables": { "batchSize": 10 },
    "resources": {},
    "actions": [],
    "nodes": [
      { "id": "start", "kind": "input", "label": "Input", "config": {} },
      {
        "id": "end",
        "kind": "output",
        "label": "Customer email",
        "config": {
          "input": {
            "type": "reference",
            "path": "trigger.body.customer.email"
          }
        }
      }
    ],
    "edges": [{ "id": "next", "source": "start", "target": "end" }]
  },
  "editor": {
    "nodes": { "start": { "x": 40, "y": 80 }, "end": { "x": 320, "y": 80 } }
  }
}
```

Submit a run with `input: { "customer": { "email": "customer@example.com" } }`. The same published V2 definition can be selected by existing REST API keys, schedules and customer workflow quick actions, subject to their current authorization/public-access rules.

AI creation clients can pass `workflowSchemaVersion: 2` to the existing creation-assistant request. The assistant still proposes a bounded chain of existing published Agent versions; the server converts that proposal into resource-referencing V2 and validates it. Omit the field to retain the current V1 proposal/UI contract. Neither path publishes or runs a proposal automatically.

V2 deliberately inherits current V1 graph limits: acyclic graphs, up to 40 nodes and 80 edges, structured parallel joins and one approval gate. Loops, mutable variables, error-handler edges, nested parallel control flow and additional connectors require later compiler/runtime increments. Strict schemas reject unsupported node configuration rather than silently dropping it.
