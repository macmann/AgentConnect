import { z } from "zod";
export const webOrigin = z
  .string()
  .max(250)
  .refine((s) => {
    try {
      const u = new URL(s);
      return (
        u.origin === s &&
        !u.hostname.includes("*") &&
        (u.protocol === "https:" ||
          (u.protocol === "http:" &&
            ["localhost", "127.0.0.1"].includes(u.hostname)))
      );
    } catch {
      return false;
    }
  }, "Use an exact HTTPS origin without a path; HTTP is only allowed for localhost");
export const widgetSettings = z
  .object({
    enabled: z.boolean().default(false),
    access: z.enum(["public", "restricted"]).default("restricted"),
    allowedOrigins: z.array(webOrigin).max(30).default([]),
    theme: z.enum(["light", "dark"]).default("light"),
    position: z.enum(["left", "right"]).default("right"),
    launcher: z.string().trim().min(1).max(30).default("Chat"),
    greeting: z.string().max(300).default("How can we help?"),
    width: z.number().int().min(280).max(600).default(380),
    height: z.number().int().min(320).max(800).default(560),
    language: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
      .default("en"),
  })
  .strict()
  .superRefine((s, c) => {
    if (s.enabled && s.access === "restricted" && !s.allowedOrigins.length)
      c.addIssue({
        code: "custom",
        message: "Add an allowed origin before enabling a restricted widget",
      });
  });
export type WidgetSettings = z.infer<typeof widgetSettings>;
