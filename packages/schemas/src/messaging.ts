import { z } from "zod";
export const messagingProvider = z.enum([
  "messenger",
  "viber",
  "telegram",
  "teams",
]);
export type MessagingProvider = z.infer<typeof messagingProvider>;
export const messagingInput = z.strictObject({
  name: z.string().trim().min(1).max(100),
  provider: messagingProvider,
  deploymentId: z.uuid(),
  credentials: z.partialRecord(
    z.enum(["token", "appSecret", "appId", "tenantId"]),
    z.string().trim().min(1).max(4096),
  ),
});
export const messagingCredentialFields: Record<
  MessagingProvider,
  {
    key: "token" | "appSecret" | "appId" | "tenantId";
    label: string;
    secret: boolean;
    required: boolean;
  }[]
> = {
  messenger: [
    {
      key: "token",
      label: "Facebook Page access token",
      secret: true,
      required: true,
    },
    {
      key: "appSecret",
      label: "Meta app secret",
      secret: true,
      required: true,
    },
  ],
  viber: [
    {
      key: "token",
      label: "Viber bot authentication token",
      secret: true,
      required: true,
    },
  ],
  telegram: [
    {
      key: "token",
      label: "Telegram BotFather token",
      secret: true,
      required: true,
    },
  ],
  teams: [
    {
      key: "appId",
      label: "Microsoft bot app ID",
      secret: false,
      required: true,
    },
    {
      key: "appSecret",
      label: "Microsoft bot client secret",
      secret: true,
      required: true,
    },
    {
      key: "tenantId",
      label: "Microsoft Entra tenant ID (single-tenant bot)",
      secret: false,
      required: false,
    },
  ],
};
