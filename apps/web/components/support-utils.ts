import type { SupportCursor } from "@agentconnect/schemas/support";
export const supportCursor = (cursor: SupportCursor | null) =>
  cursor
    ? `&before=${encodeURIComponent(cursor.before)}&beforeId=${cursor.beforeId}`
    : "";
export const caseLabel = (id: string) => `Case ${id.slice(0, 8)}`;
export const statusLabel = (value: string) =>
  value
    .split("_")
    .map((s) => s[0]?.toUpperCase() + s.slice(1))
    .join(" ");
export const supportTime = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
