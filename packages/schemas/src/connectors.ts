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
export const sharePointSiteId = z
  .string()
  .regex(/^[a-z0-9-]+\.sharepoint\.com,[a-fA-F0-9-]{36},[a-fA-F0-9-]{36}$/)
  .max(300);
export const sharePointSiteUrl = z
  .url()
  .max(1000)
  .refine((value) => {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      /^[a-z0-9-]+\.sharepoint\.com$/.test(u.hostname) &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.search &&
      !u.hash
    );
  }, "Use a public-cloud SharePoint site URL without query parameters or fragments");
export const sharePointSelection = oneDriveSelection.extend({
  siteId: sharePointSiteId,
});
export const sharePointDiscoveryInput = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("site"),
      secretId: z.uuid(),
      siteUrl: sharePointSiteUrl,
    })
    .strict(),
  z
    .object({
      action: z.literal("folders"),
      secretId: z.uuid(),
      siteId: sharePointSiteId,
      driveId: oneDriveSelection.shape.driveId,
      folderId: oneDriveSelection.shape.folderId.optional(),
    })
    .strict(),
]);
export const teamsSelection = z
  .object({
    teamId: z.uuid(),
    channelId: z
      .string()
      .regex(/^19:[a-zA-Z0-9_.-]+@thread\.(tacv2|skype)$/)
      .max(200),
    maxObjects: z.number().int().min(1).max(1000).default(100),
  })
  .strict();
export const slackSelection = z
  .object({
    teamId: z.string().regex(/^T[A-Z0-9]{2,30}$/),
    channelId: z.string().regex(/^[CG][A-Z0-9]{2,30}$/),
    maxObjects: z.number().int().min(1).max(1000).default(100),
  })
  .strict();
export const slackCredential = z
  .object({
    token: z
      .string()
      .trim()
      .regex(/^xoxp-[A-Za-z0-9-]+$/)
      .max(10000),
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
      kind: z.literal("teams"),
      selection: teamsSelection,
    })
    .strict(),
  z
    .object({
      ...connectorCommon,
      kind: z.literal("slack"),
      selection: slackSelection,
    })
    .strict(),
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
  z
    .object({
      ...connectorCommon,
      kind: z.literal("sharepoint"),
      selection: sharePointSelection,
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
