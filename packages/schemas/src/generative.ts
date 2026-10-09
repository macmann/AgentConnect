import { z } from "zod";
const title = z.string().trim().min(1).max(120);
const identifier = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const cell = z.union([
  z.string().max(2000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const tableData = {
  columns: z
    .array(z.object({ key: identifier, label: title }).strict())
    .min(1)
    .max(12),
  rows: z.array(z.record(identifier, cell)).max(100),
};
const field = z
  .object({
    name: identifier,
    label: title,
    type: z.enum([
      "text",
      "email",
      "number",
      "textarea",
      "select",
      "checkbox",
      "date",
    ]),
    required: z.boolean().default(false),
    options: z.array(z.string().min(1).max(120)).max(20).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict();
export const uiBlock = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("text"), content: z.string().max(16000) })
    .strict(),
  z
    .object({ type: z.literal("card"), title, content: z.string().max(4000) })
    .strict(),
  z
    .object({
      type: z.literal("alert"),
      title,
      content: z.string().max(4000),
      severity: z.enum(["info", "success", "warning"]).default("info"),
    })
    .strict(),
  z
    .object({
      type: z.literal("kpi"),
      title,
      value: z.union([z.string().max(120), z.number().finite()]),
    })
    .strict(),
  z.object({ type: z.literal("table"), title, ...tableData }).strict(),
  z
    .object({
      type: z.literal("chart"),
      title,
      chartType: z.enum(["bar", "line", "area", "pie", "donut", "scatter"]),
      data: z
        .array(
          z
            .object({
              label: z.string().max(80),
              value: z.number().finite().min(0).max(1e12),
            })
            .strict(),
        )
        .min(1)
        .max(30),
    })
    .strict(),
  z
    .object({
      type: z.literal("form"),
      id: identifier,
      title,
      fields: z.array(field).min(1).max(12),
      action: z.literal("data.collect"),
      submitLabel: title,
      confirmation: z.literal("confirm"),
    })
    .strict(),
  z
    .object({
      type: z.literal("action"),
      id: identifier,
      title,
      label: title,
      action: z.literal("data.collect"),
      confirmation: z.literal("confirm"),
      values: z.record(identifier, cell),
    })
    .strict(),
  z
    .object({
      type: z.literal("file"),
      title,
      format: z.enum(["txt", "md", "csv"]),
      content: z.string().max(40000).optional(),
      columns: tableData.columns.optional(),
      rows: tableData.rows.optional(),
    })
    .strict(),
]);
export const responseEnvelope = z
  .object({
    version: z.literal(1),
    message: z.string().max(16000),
    blocks: z.array(uiBlock).max(12),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.message.trim() && !v.blocks.length)
      ctx.addIssue({ code: "custom", message: "Response content is required" });
    const ids = new Set<string>();
    v.blocks.forEach((b, i) => {
      if ((b.type === "table" || b.type === "file") && b.columns) {
        const keys = b.columns.map((c) => c.key);
        if (new Set(keys).size !== keys.length)
          ctx.addIssue({
            code: "custom",
            path: ["blocks", i],
            message: "Duplicate column key",
          });
      }
      if ("id" in b) {
        if (ids.has(b.id))
          ctx.addIssue({
            code: "custom",
            path: ["blocks", i, "id"],
            message: "Duplicate action identifier",
          });
        ids.add(b.id);
      }
      if (
        b.type === "file" &&
        (b.format === "csv" ? !b.columns || !b.rows : b.content === undefined)
      )
        ctx.addIssue({
          code: "custom",
          path: ["blocks", i],
          message: "File data is required",
        });
      if (b.type === "form") {
        const names = b.fields.map((f) => f.name);
        if (new Set(names).size !== names.length)
          ctx.addIssue({
            code: "custom",
            path: ["blocks", i],
            message: "Duplicate field name",
          });
        for (const f of b.fields)
          if (
            (f.type === "select" && !f.options?.length) ||
            (f.min !== undefined && f.max !== undefined && f.min > f.max)
          )
            ctx.addIssue({
              code: "custom",
              path: ["blocks", i],
              message: "Invalid field settings",
            });
      }
    });
  });
export const blockNames = [
  "text",
  "card",
  "alert",
  "kpi",
  "table",
  "chart",
  "form",
  "action",
  "file",
] as const;
export const generativeConfig = z
  .object({
    enabled: z.boolean().default(false),
    allowedBlocks: z
      .array(z.enum(blockNames))
      .min(1)
      .max(9)
      .default([...blockNames]),
    allowPublicForms: z.boolean().default(false),
  })
  .default({
    enabled: false,
    allowedBlocks: [...blockNames],
    allowPublicForms: false,
  });
export type UIBlock = z.infer<typeof uiBlock>;
export type UIResponse = z.infer<typeof responseEnvelope>;
export type RenderedBlock = UIBlock & { artifactId?: string };
export const componentRegistry = blockNames.map((name) => ({
  name,
  version: 1,
  description: {
    text: "Plain text",
    card: "Titled text card",
    alert: "Status notice",
    kpi: "A single metric",
    table: "Bounded columns and rows",
    chart: "A structured chart with nonnegative numeric values",
    form: "Validated fields collected after explicit confirmation",
    action: "Explicitly confirmed collection of supplied values",
    file: "Controlled TXT, Markdown or CSV download",
  }[name],
  allowedActions: name === "form" || name === "action" ? ["data.collect"] : [],
}));
export function generativePrompt() {
  return `\nReturn only a JSON response conforming to this versioned schema. No Markdown fences, HTML, code or additional properties. Select suitable blocks for the user's request. Forms and action buttons only use data.collect and require confirmation=confirm. Allowed component registry: ${JSON.stringify(componentRegistry)}. Response schema: ${JSON.stringify(z.toJSONSchema(responseEnvelope, { io: "input" }))}`;
}
