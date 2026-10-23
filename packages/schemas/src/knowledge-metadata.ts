import { z } from "zod";
export const knowledgeTags = z.array(z.string().trim().min(1).max(50)).max(20);
export const knowledgeAttributes = z
  .record(
    z
      .string()
      .regex(
        /^[a-z][a-z0-9_]{0,39}$/,
        "Use a lowercase key starting with a letter; letters, numbers and underscores only",
      ),
    z.string().trim().min(1).max(200),
  )
  .refine(
    (value) => Object.keys(value).length <= 20,
    "Use at most 20 metadata fields",
  );
export type MetadataFilter = {
  tagsAll: string[];
  attributes: Record<string, string>;
};
export const metadataFilter: z.ZodType<MetadataFilter> = z
  .object({
    tagsAll: knowledgeTags.default([]),
    attributes: knowledgeAttributes.default({}),
  })
  .passthrough()
  .refine(
    (value) =>
      Object.keys(value).every(
        (key) => key === "tagsAll" || key === "attributes",
      ),
    "Only tagsAll and attributes filters are supported",
  );
export const sourceMetadataUpdate = z
  .object({
    tags: knowledgeTags,
    attributes: knowledgeAttributes,
    metadataRevision: z.number().int().min(0),
  })
  .strict();

export const aiTaggingOptions = z
  .object({
    enabled: z.boolean().default(false),
    modelId: z.uuid().nullable().default(null),
  })
  .refine((v) => !v.enabled || !!v.modelId, "Select a model for AI tagging");
export const uploadMetadata = z
  .object({
    tags: knowledgeTags.default([]),
    attributes: knowledgeAttributes.default({}),
    tagging: aiTaggingOptions.default({ enabled: false, modelId: null }),
  })
  .strict();
const metadataKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
export const bulkMetadataUpdate = z
  .object({
    sources: z
      .array(
        z.object({ id: z.uuid(), metadataRevision: z.number().int().min(0) }),
      )
      .min(1)
      .max(100),
    addTags: knowledgeTags.default([]),
    removeTags: knowledgeTags.default([]),
    setAttributes: knowledgeAttributes.default({}),
    removeAttributes: z.array(metadataKey).max(20).default([]),
    dryRun: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) => new Set(v.sources.map((s) => s.id)).size === v.sources.length,
    "Select distinct sources",
  )
  .refine(
    (v) =>
      !!(
        v.addTags.length ||
        v.removeTags.length ||
        Object.keys(v.setAttributes).length ||
        v.removeAttributes.length
      ),
    "Choose at least one change",
  )
  .refine(
    (v) =>
      !v.addTags.some((t) => v.removeTags.includes(t)) &&
      !Object.keys(v.setAttributes).some((k) => v.removeAttributes.includes(k)),
    "Do not add and remove the same tag or field",
  );
export const metadataSuggestionRequest = z
  .object({ sourceIds: z.array(z.uuid()).min(1).max(100), modelId: z.uuid() })
  .strict()
  .refine(
    (v) => new Set(v.sourceIds).size === v.sourceIds.length,
    "Select distinct sources",
  );
export const metadataSuggestion = z
  .object({ tags: knowledgeTags, attributes: knowledgeAttributes })
  .strict();
export const metadataSuggestionReview = z
  .object({
    action: z.enum(["apply", "reject"]),
    metadataRevision: z.number().int().min(0),
    tags: knowledgeTags.default([]),
    attributes: knowledgeAttributes.default({}),
  })
  .strict();
