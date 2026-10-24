# Workflow field mapping and step inspection

Select a processing node on the Build canvas and open **Input mapping**. Existing workflows continue to pass their connected predecessor's complete output, or the complete ancestor selected by the old mapping control.

## Select a single field

Keep **Single value or complete output**, choose an upstream **Source step** and select a field. The workflow Input node's declared fields are available immediately. Other fields become discoverable when you select a recorded run under **Preview mapped input**.

For nested or dynamic structures, expand **Custom field path** and enter a JSON Pointer:

| Value                            | Path                 |
| -------------------------------- | -------------------- |
| Customer name                    | `/customer/name`     |
| First item's amount              | `/items/0/amount`    |
| A key containing a slash, `a/b`  | `/a~1b`              |
| A key containing a tilde, `~key` | `/~0key`             |
| Complete upstream output         | Leave the path blank |

Arrays use zero-based indices. Field selection can read a structured object or an agent's valid JSON-text output. It does not parse Markdown code fences or extract JSON from prose. Numbers, booleans, arrays, objects and null retain their types. Paths do not execute code, expressions, wildcards or transformations. Reserved prototype-property names cannot be selected.

## Assemble named fields

Choose **Named fields**, then add a target field name, upstream source and field path for each entry. For example:

```json
{
  "customer_name": "Alice",
  "risk_score": 0.25,
  "approved": false
}
```

Each target can come from a different ancestor. Up to 20 uniquely named fields are supported. Targets are flat names, not nested output paths. Sources must be upstream of the receiving node; unrelated or downstream references are invalid. On conditional paths, a source that did not execute is unavailable.

Agents receive the assembled object as JSON in their user message, with any configured prefix/suffix. Tool nodes use named fields as actual tool arguments, preserving their types and overriding matching static arguments while retaining other static arguments. This mode replaces the legacy single **Input argument name** setting; that control is disabled while named mappings are active. Tool argument-schema validation and permissions still apply, and workflow tools remain read-only.

Switching modes clears incompatible mapping settings. Save and publish to update API/scheduled execution; existing published versions, schedules pinned to them and recorded runs retain their snapshots. Copy/paste and reusable component insertion remap internal field references. Components cannot reference sources outside their selected group.

## Preview without executing

Expand **Preview mapped input**, select a recorded run and inspect the mapped result. Agent nodes also expose their user-message preview; tool nodes show the resulting arguments. No model or tool call is made.

Previews use completed node outputs recorded in that run and may be redacted. A warning appears when its graph differs from the current draft. Values are samples, not a promise of future output structure. Unexecuted/failed branches do not supply usable sample outputs. Use a new test run to validate the saved draft with representative input.

Missing sources or fields fail explicitly rather than falling back to another value:

- `WORKFLOW_MAPPING_UNAVAILABLE`: the selected source has no available output, including an unselected branch.
- `WORKFLOW_MAPPING_FIELD_MISSING`: an object key or array item is absent, or the path traverses a scalar/null value.
- `WORKFLOW_MAPPING_NOT_STRUCTURED`: field selection was requested from plain text rather than valid JSON.
- `WORKFLOW_MAPPING_PATH_INVALID`: invalid or unsafe pointer syntax.

Runtime mapping failures are recorded on the failed node, and later steps do not run. The same resolver powers preview and execution; snapshots, current permissions and dependency checks remain authoritative.

## Inspect a step from the canvas

While viewing a run, click a node to open its **Step details** in the canvas test panel. The **Inspect step** dropdown provides keyboard access to the same selection. Details use the run's immutable graph, including when the current draft has changed.

The panel shows recorded input/output, execution status, duration, reported token usage, attempts, retry history, citations and that node's tool executions. Steps with no execution record say so explicitly. Existing full-run execution details remain available.

No migration or new dependency is required. Restart/rebuild API, worker and web together to use the new mappings.
