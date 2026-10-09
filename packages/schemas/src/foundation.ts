import { z } from "zod";
export const roles = [
  "owner",
  "org_admin",
  "workspace_admin",
  "builder",
  "operator",
  "analyst",
  "viewer",
] as const;
export type Role = (typeof roles)[number];
export const credentials = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase()),
  password: z.string().min(12).max(128),
});
export const register = credentials.extend({
  name: z.string().trim().min(1).max(100),
});
export const named = z.object({ name: z.string().trim().min(1).max(100) });
export const invitation = z.object({
  email: z.email().transform((v) => v.toLowerCase()),
  role: z.enum(roles).exclude(["owner"]),
  workspaceId: z.uuid().optional(),
});
export const secretInput = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  value: z.string().min(1).max(16384),
});
export const tokenInput = z.object({ token: z.string().min(32).max(128) });
export const resetInput = tokenInput.extend({
  password: credentials.shape.password,
});
export const emailInput = z.object({ email: credentials.shape.email });
export const capabilities = [
  "operations:view",
  "operations:manage",
  "member:manage",
  "conversation:review",
  "workspace:create",
  "member:invite",
  "secret:manage",
  "audit:view",
  "model:manage",
  "agent:create",
  "agent:update",
  "agent:publish",
  "agent:delete",
  "agent:execute",
  "conversation:view",
  "workflow:manage",
  "workflow:read",
  "workflow:execute",
  "workflow:approve",
  "tool:manage",
  "tool:read",
  "tool:execute",
  "knowledge:manage",
  "knowledge:read",
  "knowledge:retrieve",
] as const;
export type Capability = (typeof capabilities)[number];
const grants: Record<Role, readonly Capability[]> = {
  owner: capabilities,
  org_admin: capabilities,
  workspace_admin: capabilities.filter((c) => c !== "workspace:create"),
  builder: [
    "operations:view",
    "conversation:review",
    "workflow:manage",
    "workflow:read",
    "workflow:execute",
    "tool:read",
    "tool:execute",
    "knowledge:manage",
    "knowledge:read",
    "knowledge:retrieve",
    "agent:create",
    "agent:update",
    "agent:publish",
    "agent:delete",
    "agent:execute",
    "conversation:view",
  ],
  operator: [
    "operations:view",
    "conversation:review",
    "workflow:read",
    "workflow:approve",
    "conversation:view",
    "knowledge:read",
    "tool:read",
  ],
  analyst: [
    "operations:view",
    "conversation:view",
    "workflow:read",
    "audit:view",
    "knowledge:read",
    "knowledge:retrieve",
  ],
  viewer: [],
};
export function permitted(role: Role, capability: Capability) {
  return grants[role].includes(capability);
}
