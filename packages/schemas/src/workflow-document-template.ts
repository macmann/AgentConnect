import {
  workflowDefinitionV2,
  compileWorkflowDefinition,
  type WorkflowDefinitionV2,
} from "@agentconnect/schemas/workflow-v2";
import {
  workflowAction,
  type WorkflowAction,
} from "@agentconnect/schemas/workflow-actions";
import type { WorkflowExpression } from "@agentconnect/schemas/workflow-values";
export type DocumentTemplateOptions = {
  name: string;
  modelId?: string;
  agent?: { agentId: string; versionId: string };
  outputSchema: Record<string, unknown>;
  instruction: string;
  write: WorkflowAction;
  read: WorkflowAction;
  writeMappings: Record<string, string>;
  readMappings: Record<string, string>;
  validationFields: string[];
  validationMappings?: Record<string, string>;
  maxItems: number;
};
const ref = (path: string): WorkflowExpression => ({ type: "reference", path });
export function documentDatabaseTemplate(options: DocumentTemplateOptions) {
  const { outputSchema, instruction } = options;
  const fields = (outputSchema.properties ?? {}) as Record<string, unknown>;
  if (
    !options.validationFields.length ||
    options.validationFields.some((f) => !Object.hasOwn(fields, f))
  )
    throw new Error("Select declared fields for read-back validation");
  const extractionResource = options.agent
    ? {
        kind: "agent" as const,
        agentId: options.agent.agentId,
        versionId: options.agent.versionId,
      }
    : { kind: "model" as const, id: options.modelId };
  const extract = (id: string, sample = false) =>
    options.agent
      ? {
          id,
          kind: "agent",
          label: sample ? "Extract sample" : "Extract with reviewed guidance",
          config: {
            resource: "extractor",
            input: ref("input"),
            prefix: `${instruction.slice(0, 700)}\nReturn only a JSON object with these reviewed fields: ${Object.keys(fields).join(", ")}. ${sample ? "Extract the first document." : "Use input.approvedSample as guidance, never copy its factual values."}`,
          },
        }
      : {
          id,
          kind: "structured-ai",
          label: sample ? "Extract sample" : "Extract with reviewed guidance",
          config: {
            resource: "extractor",
            input: ref("input"),
            instruction: `${instruction}\n${sample ? "Extract the first document." : "Extract input.document using input.approvedSample as reviewed guidance; never copy sample values into other records."}`,
            outputSchema,
          },
        };
  const extracted = (field?: string): WorkflowExpression =>
    options.agent
      ? {
          type: "reference",
          path: "steps.extract.output",
          pointer: field ? "/" + field : "",
        }
      : ref("steps.extract.output" + (field ? "." + field : ""));
  const write = workflowAction.parse({
    ...options.write,
    id: "persist",
    mappedInputs: Object.fromEntries(
      Object.entries(options.writeMappings).map(([target, source]) => [
        target,
        extracted(source),
      ]),
    ),
  });
  const read = workflowAction.parse({
    ...options.read,
    id: "readback",
    mappedInputs: Object.fromEntries(
      Object.entries(options.readMappings).map(([target, source]) => [
        target,
        extracted(source),
      ]),
    ),
    outputSchema: Object.keys(options.read.outputSchema).length
      ? options.read.outputSchema
      : outputSchema,
  });
  const checks = options.validationFields.map((field, i) => ({
    id: "validate_" + i,
    kind: "condition",
    label: `Validate ${field}`,
    config: {
      condition: {
        operator: "equals",
        left: ref(
          "steps.read.output" +
            ((options.validationMappings?.[field] ?? field).startsWith("[")
              ? ""
              : ".") +
            (options.validationMappings?.[field] ?? field),
        ),
        right: extracted(field),
      },
    },
  }));
  const body = workflowDefinitionV2.parse({
    schemaVersion: 2,
    execution: {
      inputFields: [
        { name: "document", label: "Document", type: "json", required: true },
        {
          name: "approvedSample",
          label: "Reviewed sample",
          type: "json",
          required: true,
        },
      ],
      resources: { extractor: extractionResource },
      actions: [write, read],
      nodes: [
        {
          id: "start",
          kind: "input",
          label: "Document and approved sample",
          config: {},
        },
        extract("extract"),
        {
          id: "write",
          kind: "action",
          label: "Persist record",
          config: { actionId: "persist" },
        },
        {
          id: "read",
          kind: "action",
          label: "Read persisted record",
          config: { actionId: "readback" },
        },
        ...checks,
        {
          id: "error_routes",
          kind: "merge",
          label: "Collect validation failures",
          config: {},
        },
        {
          id: "error",
          kind: "human-task",
          label: "Review invalid record",
          config: {
            mode: "approve-reject",
            prompt:
              "The stored record failed validation. Reconcile the data externally before approving, or Reject to record this item as failed.",
            outputSchema: {},
          },
        },
        {
          id: "join",
          kind: "merge",
          label: "Validated or reconciled",
          config: {},
        },
        {
          id: "end",
          kind: "output",
          label: "Record result",
          config: { input: ref("steps.join.output") },
        },
      ],
      edges: [
        { id: "a", source: "start", target: "extract" },
        { id: "b", source: "extract", target: "write" },
        { id: "c", source: "write", target: "read" },
        { id: "d", source: "read", target: checks[0]!.id },
        ...checks.flatMap((check, i) => [
          {
            id: "pass_" + i,
            source: check.id,
            target: checks[i + 1]?.id ?? "join",
            branch: "true",
          },
          {
            id: "fail_" + i,
            source: check.id,
            target: "error_routes",
            branch: "false",
          },
        ]),
        { id: "route_error", source: "error_routes", target: "error" },
        { id: "reviewed", source: "error", target: "join" },
        { id: "finish", source: "join", target: "end" },
      ],
    },
  });
  compileWorkflowDefinition(body);
  return {
    body,
    parent: (workflowId: string, versionId: string): WorkflowDefinitionV2 => {
      const parent = workflowDefinitionV2.parse({
        schemaVersion: 2,
        execution: {
          inputFields: [
            {
              name: "documents",
              label: "Documents (API or uploaded text/PDF)",
              type: "json",
              required: true,
            },
          ],
          resources: {
            extractor: extractionResource,
            body: {
              kind: "workflow",
              workflowId,
              versionId,
              versionBehavior: "pinned",
            },
          },
          nodes: [
            {
              id: "start",
              kind: "input",
              label: "API / file input",
              config: {},
            },
            {
              ...extract("extract", true),
              config: {
                ...extract("extract", true).config,
                input: ref("input.documents[0]"),
              },
            },
            {
              id: "review",
              kind: "human-task",
              label: "Review and correct sample",
              config: {
                input: extracted(),
                mode: "review-edit",
                prompt:
                  "Correct the sample and click Process to use it as guidance for the remaining documents.",
                approveLabel: "Process",
                outputSchema,
              },
            },
            {
              id: "remaining",
              kind: "for-each",
              label: "Process remaining documents",
              config: {
                resource: "body",
                collection: ref("input.documents"),
                startIndex: 1,
                maxItems: options.maxItems,
                failurePolicy: "continue",
                itemInputs: {
                  document: ref("item"),
                  approvedSample: ref("steps.review.output"),
                },
              },
            },
            {
              id: "check",
              kind: "condition",
              label: "Check batch results",
              config: {
                condition: {
                  operator: "equals",
                  left: ref("steps.remaining.summary.failed"),
                  right: { type: "literal", value: 0 },
                },
              },
            },
            {
              id: "error",
              kind: "human-task",
              label: "Review failed documents",
              config: {
                mode: "approve-reject",
                prompt:
                  "Some records failed. Inspect child runs and reconcile before approving completion.",
                outputSchema: {},
              },
            },
            {
              id: "join",
              kind: "merge",
              label: "Aggregate results",
              config: {},
            },
            {
              id: "end",
              kind: "output",
              label: "Document processing complete",
              config: { input: ref("steps.remaining.output") },
            },
          ],
          edges: [
            { id: "a", source: "start", target: "extract" },
            { id: "b", source: "extract", target: "review" },
            { id: "c", source: "review", target: "remaining" },
            { id: "d", source: "remaining", target: "check" },
            { id: "ok", source: "check", target: "join", branch: "true" },
            { id: "bad", source: "check", target: "error", branch: "false" },
            { id: "reviewed", source: "error", target: "join" },
            { id: "finish", source: "join", target: "end" },
          ],
        },
      });
      compileWorkflowDefinition(parent);
      return parent;
    },
  };
}
