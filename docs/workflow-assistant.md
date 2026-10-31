# AI-assisted Workflow V2 configuration

The studio assistant creates or edits the same `WorkflowDefinitionV2` used by the manual canvas, compiler and durable runtime. It has no code-generation executor, background modification loop, resource-creation privileges or execution tools. Existing Agents, KB/RAG, Tools, MCP, models, connections and secrets remain independent resources.

## User flow

Open **AI assistant** in the V2 canvas toolbar. The assistant occupies the existing contained, scrollable property drawer; it can be minimized/restored. Choose:

- **Create workflow from description**: propose a new canonical V2 definition or explicit mutations.
- **Modify current workflow**: propose structural/configuration mutations against the unsaved canvas definition.
- **Configure selected node**: change that step's configuration/mappings, condition, unshared Action or its own resource reference. Structural edits and shared Action/resource changes require Modify workflow.
- **Explain workflow**: describe the supplied actual definition, including trigger, processing, AI decisions, review gates, external writes and failure handling. This mode cannot return an editable proposal.

The request produces a validated proposal, a change list, readable field mappings, optional structured details and warnings. The canvas shows the proposal with editing and Save/Publish disabled. The original draft remains unchanged. **Cancel proposal** restores the original canvas; **Apply proposal** revalidates live dependencies, then changes only the local draft. Save and Publish remain separate normal workflow operations. A canceled/in-flight or closed panel cannot apply a late response. Changed source definitions or selected-node scope invalidate Apply. Connection changes can also invalidate Apply or require review of new warnings.

Warnings include writes/deletes, high risk and unknown source schemas. The user must acknowledge warnings before Apply. Referenced published child flows are inspected too, so their side effects and revoked resources do not disappear behind a For Each or Subworkflow node. Preview does not invoke Actions or run children.

The feature reuses the workspace's existing **AI creation** opt-in/model setting. Administrators select the provider/model through existing Settings. Generation/editing requires `workflow:manage`; Explain requires `workflow:read`, preserving current role policy. Unavailable/archived assistant models fail through existing model configuration checks. Manual editing remains available when AI is disabled or unavailable.

## API and model contract

`POST /workspaces/:workspaceId/workflow-assistant` accepts:

```json
{
  "mode": "modify",
  "prompt": "Add manager approval before the database write",
  "workflowId": "optional existing workflow UUID",
  "selectedNodeId": "optional node identifier",
  "definition": {
    "schemaVersion": 2,
    "execution": { "nodes": [], "edges": [] }
  }
}
```

The abbreviated definition above illustrates the envelope; a real request must contain a schema-valid canvas definition. `workflowId`, when supplied, must belong to the same active workspace. The unsaved definition is deliberately the source of truth for the request; the assistant does not reload an older saved draft.

The model receives a bounded JSON Schema describing the response envelope, canonical V2 nodes, Actions, references, conditions, resources and mutations. It also receives safe workspace catalog metadata, current definition for edits, selected ID, published child definitions, output/input schemas, and configured webhook input schemas. HTTP connections expose names/IDs, base paths, methods, scopes and idempotency declarations. MCP metadata exposes existing operations, schemas and explicit grant status. Secret values and encrypted ciphertext are never fetched for the model. Sensitive field names pass through existing redaction. Names/descriptions/current content are treated as untrusted data, never higher-priority instructions. Do not paste credentials into assistant prompts or workflow literals.

Valid response kinds:

```json
{
  "kind": "definition",
  "message": "Review this workflow",
  "definition": { "schemaVersion": 2, "execution": {} }
}
```

```json
{ "kind": "mutations", "message": "Review adding approval", "operations": [] }
```

```json
{
  "kind": "explanation",
  "message": "Plain-language explanation of the actual workflow"
}
```

```json
{
  "kind": "clarification",
  "message": "Publish a per-document body before creating this For Each"
}
```

These examples abbreviate required content. Only Create accepts a complete replacement definition. Modify/Configure require mutations. Explain accepts only explanation/clarification. Clarification returns no candidate or Apply control. The server returns a candidate definition, operations, computed changes/warnings, message, mode and canonical source digest; it writes no workflow/version/run rows.

`POST /workspaces/:workspaceId/workflow-assistant/validate` accepts `{definition, workflowId?}` and repeats compilation, current tenant/resource/Action policy checks and bounded child-dependency checks immediately before local Apply. It does not persist or execute anything. Normal Save/Publish/run APIs continue to enforce their own contracts.

## Mutation operations

| Operation                           | Payload                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `addNode`                           | `node` (complete V2 node), optional `nearNodeId`                                                           |
| `removeNode`                        | `nodeId`; also removes incident edges and its position                                                     |
| `updateNode`                        | `nodeId`, complete replacement `node` retaining its ID                                                     |
| `connect`                           | `edge` with ID/source/target/optional branch                                                               |
| `disconnect`                        | `edgeId`                                                                                                   |
| `updateMapping`                     | `nodeId`, `target` (`input`, `inputs`, `fields`, `itemInputs`), optional `field`, typed expression `value` |
| `updateCondition`                   | `nodeId`, typed `condition`                                                                                |
| `upsertAction` / `removeAction`     | full canonical `action` / `actionId`                                                                       |
| `upsertResource` / `removeResource` | `name` plus canonical reference / `name`                                                                   |
| `setVariable`                       | `name`, literal JSON `value`                                                                               |
| `setInputFields`                    | canonical `fields` array                                                                                   |

Operations apply to an isolated copy and compile together as one transaction in memory. Intermediate edge changes may temporarily disconnect the copy; the final graph must pass the normal validator. The source object is never mutated. There is no arbitrary JSON Patch, property-path assignment, JavaScript expression or `eval` operation. Reserved identifiers/prototype traversal are rejected by existing reference/identifier schemas. Mutation errors and invalid final graphs return no candidate.

To insert a review step, explicitly disconnect the old edge, add the Human Task with `nearNodeId`, then connect predecessor → review → successor. Existing positions, viewport and unaffected edge-port choices are retained. New nodes are placed near their anchor without overlapping existing positions where space permits. Create assigns a simple local grid; the model does not control layout or rearrange existing nodes during edits.

## Mapping and resource validation

Static/mapped input precedence and typed references remain the existing runtime rules. For example:

```json
{
  "op": "updateMapping",
  "nodeId": "save_invoice",
  "target": "inputs",
  "field": "invoiceNumber",
  "value": { "type": "reference", "path": "steps.extract.output.invoiceNumber" }
}
```

The compiler checks ancestor relationships, declared source fields/types and required Action inputs. The assistant also validates a transient V2 copy against actual registered Tool/MCP operation schemas, so omitting or changing an Action assertion cannot hide required connector fields. The original definition remains canonical; no resource configuration is copied into the saved workflow. The assistant additionally checks configured webhook schemas. Unknown dynamic source schemas produce explicit **Verify mapping** warnings rather than a false assurance. Declared nonexistent fields and primitive traversal reject the proposal. Legacy JSON Pointer mappings are explicitly flagged for runtime verification; literal payloads that resemble reference objects are not mistaken for expressions. `arguments.*` remains scoped to Action HTTP request construction; Action input mappings cannot reference themselves.

The assistant cannot create connections, credentials, MCP grants, providers or Agents, or bypass disabled resources. It may propose write/high-risk Actions only within current saved-connection/MCP grant policy. Write retries still require actual remote idempotency support. No new runtime guarantees are inferred from the prompt. Existing Agent Tool/LLM policy is unchanged.

## OCR/PDF scenario and limits

The acceptance fixture in `apps/api/test/workflow-assistant.test.ts` asks for OCR/PDF documents → Structured AI sample extraction → Human Review/Edit with **Process** → For Each remaining document. Its published body uses approved sample guidance → Structured AI → explicitly granted MCP database write → database read → typed validation → completion or Human Error Review. The generated definition passes normal validation. This complements the existing Action/runtime fixture that executes the extraction/review/write/read/condition sequence with mocked external systems and durable orchestration.

For Each continues to reference a published child workflow, never an AI-only inline body. The assistant can select a suitable existing published body from the catalog; otherwise it asks for that prerequisite. It does not automatically create/publish child workflows, configure an upload integration, or invent a binary OCR processor. Supply OCR text/data through existing inputs/integrations and review capability descriptions.

Requests are bounded to 200 KB, prompts to 4,000 characters, proposals to 180,000 characters, 100 mutations and existing V2 limits (40 nodes, 80 edges, 40 Actions). Model calls use temperature 0, a 90-second deadline and up to 16,384 output tokens within the configured model's limits. The complete context is budgeted before calling the provider; oversized workflows/catalogs require a larger-context model or simplification. Generation is rate-limited to 10 requests/minute per existing API rate-limit identity. Published dependency preview is bounded to 40 inspected workflows and the runtime's four-level invocation depth; recursive references fail closed. The catalog includes at most 30 published body versions for model context; it never fabricates missing IDs.

Invalid structured output, unknown mutations, malformed/cyclic graphs, invented resources and unsafe Actions are rejected before preview. Provider failures return safe codes. Audit events store mode/model/change counts and proposal presence, not raw prompts, generated definitions or credentials. No database migration or second workflow engine is introduced.
