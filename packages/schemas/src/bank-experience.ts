import { z } from "zod";
const key = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const quickAction = z.strictObject({
  id: key,
  label: z.string().trim().min(1).max(80),
  message: z.string().trim().min(1).max(1000),
  behavior: z.enum(["send", "populate", "journey", "handoff"]).default("send"),
  journeyId: key.nullable().default(null),
});
export const supportJourney = z
  .strictObject({
    id: key,
    name: z.string().trim().min(1).max(100),
    description: z.string().max(500).default(""),
    fields: z
      .array(
        z.strictObject({
          key: key.refine(
            (v) =>
              !/(^|_)(password|pin|otp|cvv|account_number|card_number)($|_)/i.test(
                v,
              ),
            "Do not collect credentials or full financial identifiers",
          ),
          label: z.string().trim().min(1).max(100),
          question: z.string().trim().min(1).max(500),
        }),
      )
      .min(1)
      .max(8),
    completion: z.enum(["guidance", "handoff"]).default("guidance"),
  })
  .refine(
    (v) => new Set(v.fields.map((f) => f.key)).size === v.fields.length,
    "Journey field keys must be unique",
  );
export const answerPolicy = z
  .strictObject({
    mode: z.enum(["standard", "grounded"]).default("standard"),
    noAnswerResponse: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .default(
        "I couldn't find approved guidance for that question. Please clarify your request or connect with customer care.",
      ),
    offerHumanOnNoAnswer: z.boolean().default(true),
  })
  .default({
    mode: "standard",
    noAnswerResponse:
      "I couldn't find approved guidance for that question. Please clarify your request or connect with customer care.",
    offerHumanOnNoAnswer: true,
  });
export type QuickAction = z.infer<typeof quickAction>;
export type SupportJourney = z.infer<typeof supportJourney>;
export const bankingTemplates: {
  actions: QuickAction[];
  journeys: SupportJourney[];
} = {
  actions: [
    ["forgot_password", "Forgot Password", "I forgot my password."],
    ["login_issue", "Login Issues", "I need help logging in."],
    ["device_change", "Device Change", "I need help changing my device."],
    [
      "transfer_dispute",
      "Transfer Issue",
      "I need help with a transfer issue.",
    ],
    ["bill_payment", "Bill Payment", "I need help with a bill payment."],
    ["card_support", "Card Support", "I need help with my card."],
    ["branch_locator", "Find Nearest Branch", "Help me find a branch."],
    [
      "customer_care",
      "Talk to Customer Care",
      "I would like to speak to customer care.",
    ],
  ].map(([id, label, message]) => ({
    id: id!,
    label: label!,
    message: message!,
    behavior:
      id === "customer_care"
        ? "handoff"
        : [
              "forgot_password",
              "login_issue",
              "device_change",
              "transfer_dispute",
            ].includes(id!)
          ? "journey"
          : "send",
    journeyId: [
      "forgot_password",
      "login_issue",
      "device_change",
      "transfer_dispute",
    ].includes(id!)
      ? id!
      : null,
  })),
  journeys: [
    {
      id: "forgot_password",
      name: "Forgot password",
      description: "Collect context, then retrieve approved recovery guidance.",
      completion: "guidance",
      fields: [
        {
          key: "service",
          label: "Service",
          question: "Which app or service are you trying to access?",
        },
        {
          key: "issue",
          label: "Problem",
          question:
            "What happens when you select password recovery? Do not share passwords, PINs or verification codes.",
        },
      ],
    },
    {
      id: "login_issue",
      name: "Login issue",
      description:
        "Clarify the login problem before searching approved troubleshooting.",
      completion: "guidance",
      fields: [
        {
          key: "service",
          label: "Service",
          question: "Which app or service are you trying to access?",
        },
        {
          key: "error",
          label: "Error message",
          question:
            "What error do you see? Do not include passwords, PINs or verification codes.",
        },
      ],
    },
    {
      id: "device_change",
      name: "Device change",
      description:
        "Identify the service and situation; use approved device-change guidance.",
      completion: "guidance",
      fields: [
        {
          key: "service",
          label: "Service",
          question:
            "Which app or service do you need to use on your new device?",
        },
        {
          key: "old_device",
          label: "Old device availability",
          question: "Do you still have access to your old device?",
        },
      ],
    },
    {
      id: "transfer_dispute",
      name: "Transfer dispute",
      description:
        "Collect investigation context for customer care; performs no banking transaction.",
      completion: "handoff",
      fields: [
        {
          key: "service",
          label: "Service",
          question: "Which app or service was used for the transfer?",
        },
        {
          key: "date",
          label: "Transfer date",
          question: "When did you make the transfer?",
        },
        {
          key: "reference",
          label: "Transaction reference",
          question:
            "What is the transaction reference, if available? Reply “unknown” if unavailable. Do not share account/card numbers, passwords, PINs or verification codes.",
        },
        {
          key: "issue",
          label: "Issue",
          question:
            "What went wrong: failed, pending, missing funds or another issue?",
        },
      ],
    },
  ],
};
