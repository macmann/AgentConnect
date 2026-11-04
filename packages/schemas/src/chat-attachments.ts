import { z } from "zod";
export const attachmentAccept =
  ".png,.jpg,.jpeg,.webp,.pdf,.docx,.pptx,.xlsx,.txt,.md,.csv,.json";
export const maxAttachmentBytes = 4 * 1024 * 1024;
export const maxTotalAttachmentBytes = 8 * 1024 * 1024;
export const chatAttachment = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine((s) => !/[\\/\x00-\x1f]/.test(s), "Use a plain filename"),
  data: z
    .string()
    .min(4)
    .max(Math.ceil(maxAttachmentBytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type ChatAttachment = z.infer<typeof chatAttachment>;
export type AttachmentInfo = {
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "document";
};
