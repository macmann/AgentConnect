import { z } from "zod";
import { ConnectorError } from "./connector-adapters.js";
export type FeedResult = { cursor: string; changed: boolean };
type Json = (url: string, signal: AbortSignal) => Promise<unknown>;
const token = z.string().min(1).max(10000);
// The feed is an invalidation signal. A changed scope is reconciled with the
// existing complete inventory, including moves, folders and access changes.
export async function googleChanges(
  json: Json,
  signal: AbortSignal,
  cursor?: string,
): Promise<FeedResult> {
  const base = "https://www.googleapis.com/drive/v3/changes";
  if (!cursor) {
    const result = z
      .object({ startPageToken: token })
      .parse(
        await json(base + "/startPageToken?supportsAllDrives=true", signal),
      );
    return { cursor: result.startPageToken, changed: true };
  }
  const seen = new Set<string>();
  let next = cursor,
    changed = false;
  for (let pages = 0; pages < 100; pages++) {
    if (seen.has(next)) throw new ConnectorError("CONNECTOR_INVALID_LISTING");
    seen.add(next);
    const page = z
      .object({
        changes: z
          .array(
            z.object({
              fileId: z.string().optional(),
              removed: z.boolean().optional(),
            }),
          )
          .max(1000),
        nextPageToken: token.optional(),
        newStartPageToken: token.optional(),
      })
      .parse(
        await json(
          base +
            "?" +
            new URLSearchParams({
              pageToken: next,
              pageSize: "1000",
              supportsAllDrives: "true",
              includeItemsFromAllDrives: "true",
              fields: "changes(fileId,removed),nextPageToken,newStartPageToken",
            }),
          signal,
        ),
      );
    changed ||= page.changes.length > 0;
    if (page.nextPageToken) {
      next = page.nextPageToken;
      continue;
    }
    if (!page.newStartPageToken)
      throw new ConnectorError("CONNECTOR_INVALID_LISTING");
    return { cursor: page.newStartPageToken, changed };
  }
  throw new ConnectorError("CONNECTOR_SOURCE_LIMIT");
}
export async function microsoftChanges(
  json: Json,
  signal: AbortSignal,
  driveId: string,
  cursor?: string,
): Promise<FeedResult> {
  const base = `https://graph.microsoft.com/v1.0/drives/${driveId}/root/delta`;
  const validate = (value: string) => {
    const u = new URL(value),
      expected = new URL(base);
    if (
      u.origin !== expected.origin ||
      decodeURIComponent(u.pathname) !== expected.pathname ||
      u.username ||
      u.password ||
      u.hash ||
      value.length > 10000
    )
      throw new ConnectorError("CONNECTOR_INVALID_LISTING");
    return u.toString();
  };
  let next = cursor ? validate(cursor) : base + "?token=latest",
    changed = !cursor;
  const seen = new Set<string>();
  for (let pages = 0; pages < 100; pages++) {
    if (seen.has(next)) throw new ConnectorError("CONNECTOR_INVALID_LISTING");
    seen.add(next);
    const page = z
      .object({
        value: z.array(z.object({ id: z.string() }).passthrough()).max(10000),
        "@odata.nextLink": token.optional(),
        "@odata.deltaLink": token.optional(),
      })
      .parse(await json(next, signal));
    changed ||= page.value.length > 0;
    if (page["@odata.nextLink"]) {
      next = validate(page["@odata.nextLink"]);
      continue;
    }
    if (!page["@odata.deltaLink"])
      throw new ConnectorError("CONNECTOR_INVALID_LISTING");
    return { cursor: validate(page["@odata.deltaLink"]), changed };
  }
  throw new ConnectorError("CONNECTOR_SOURCE_LIMIT");
}
export async function recoverFeed(
  run: (cursor?: string) => Promise<FeedResult>,
  cursor?: string,
) {
  try {
    return await run(cursor);
  } catch (error) {
    if (
      cursor &&
      error instanceof ConnectorError &&
      error.code === "CONNECTOR_CURSOR_EXPIRED"
    )
      return run();
    throw error;
  }
}
