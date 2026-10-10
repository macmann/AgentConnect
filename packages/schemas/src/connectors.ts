import { z } from "zod";
export const s3Selection = z
  .object({
    endpoint: z.url().max(500),
    region: z.string().regex(/^[a-z0-9-]{1,50}$/),
    bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
    prefix: z.string().max(1000).default(""),
    maxObjects: z.number().int().min(1).max(1000).default(100),
  })
  .strict();
export const s3Credential = z
  .object({
    accessKeyId: z.string().trim().min(1).max(256),
    secretAccessKey: z.string().min(8).max(500),
    sessionToken: z.string().min(1).max(10000).optional(),
  })
  .strict();
export const googleDriveSelection = z
  .object({
    folderId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
    recursive: z.boolean().default(true),
    maxObjects: z.number().int().min(1).max(1000).default(100),
  })
  .strict();
export const googleDriveCredential = z.object({
  client_email: z.email().max(320),
  private_key: z.string().min(100).max(20000),
});
export const oneDriveSelection = z
  .object({
    driveId: z.string().regex(/^[a-zA-Z0-9!_-]{1,200}$/),
    folderId: z.string().regex(/^[a-zA-Z0-9!_-]{1,200}$/),
    recursive: z.boolean().default(true),
    maxObjects: z.number().int().min(1).max(1000).default(100),
  })
  .strict();
export const oneDriveCredential = z
  .object({
    tenantId: z.uuid(),
    clientId: z.uuid(),
    clientSecret: z.string().min(1).max(10000),
  })
  .strict();
const connectorCommon = {
  name: z.string().trim().min(1).max(100),
  knowledgeBaseId: z.uuid(),
  secretId: z.uuid(),
  scheduleMinutes: z.number().int().min(15).max(10080).nullable().default(null),
};
export const connectorInput = z.discriminatedUnion("kind", [
  z
    .object({
      ...connectorCommon,
      kind: z.literal("s3"),
      selection: s3Selection,
    })
    .strict(),
  z
    .object({
      ...connectorCommon,
      kind: z.literal("google-drive"),
      selection: googleDriveSelection,
    })
    .strict(),
  z
    .object({
      ...connectorCommon,
      kind: z.literal("onedrive"),
      selection: oneDriveSelection,
    })
    .strict(),
]);
export const connectorUpdate = z
  .object({
    maxObjects: z.number().int().min(1).max(1000).optional(),
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(100),
    secretId: z.uuid(),
    enabled: z.boolean(),
    scheduleMinutes: z.number().int().min(15).max(10080).nullable(),
  })
  .strict();
export type S3Selection = z.infer<typeof s3Selection>;
