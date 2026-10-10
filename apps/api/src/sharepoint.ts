import { z } from "zod";
import {
  oneDriveCredential,
  oneDriveSelection,
  sharePointSelection,
  sharePointSiteId,
  sharePointSiteUrl,
} from "@agentconnect/schemas/connectors";
import { ConnectorError, type SourceAdapter } from "./connector-adapters.js";
import { createOneDriveAdapter } from "./onedrive-adapter.js";
import {
  createMicrosoftGraphClient,
  safeGraphOperation,
  type GraphTransport,
  type MicrosoftGraphClient,
} from "./microsoft-graph-client.js";
const graphBase = "https://graph.microsoft.com/v1.0";
const webUrl = z
  .url()
  .max(2000)
  .refine((value) => {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password;
  });
const siteSchema = z.object({
  id: sharePointSiteId,
  displayName: z.string().min(1).max(1000),
  webUrl,
});
const librarySchema = z.object({
  id: oneDriveSelection.shape.driveId,
  name: z.string().min(1).max(1000),
  driveType: z.literal("documentLibrary"),
  webUrl,
});
const folderSchema = z.object({
  id: oneDriveSelection.shape.folderId,
  name: z.string().min(1).max(1000),
  webUrl,
  folder: z.object({}).optional(),
  parentReference: z
    .object({ driveId: z.string(), id: z.string().optional() })
    .optional(),
  remoteItem: z.unknown().optional(),
  deleted: z.unknown().optional(),
});
export type SharePointSite = z.infer<typeof siteSchema>;
export type SharePointLibrary = z.infer<typeof librarySchema>;
export type SharePointFolder = Pick<
  z.infer<typeof folderSchema>,
  "id" | "name" | "webUrl"
>;
export interface SharePointClient {
  resolveSite(siteUrl: string, signal: AbortSignal): Promise<SharePointSite>;
  libraries(siteId: string, signal: AbortSignal): Promise<SharePointLibrary[]>;
  folders(
    siteId: string,
    driveId: string,
    folderId: string | undefined,
    signal: AbortSignal,
  ): Promise<{ folder: SharePointFolder; folders: SharePointFolder[] }>;
  verifyLibrary(
    siteId: string,
    driveId: string,
    signal: AbortSignal,
  ): Promise<void>;
  close(): void;
}
export type SharePointClientFactory = (
  credential: z.infer<typeof oneDriveCredential>,
) => SharePointClient;
export function createSharePointClient(
  credential: z.infer<typeof oneDriveCredential>,
  transport?: GraphTransport,
  sharedGraph?: MicrosoftGraphClient,
): SharePointClient {
  const graph =
    sharedGraph ?? createMicrosoftGraphClient(credential, transport);
  const url = (path: string, select: string, collection = false) =>
    graphBase +
    path +
    "?" +
    new URLSearchParams({
      $select: select,
      ...(collection ? { $top: "100" } : {}),
    });
  function sameHost(value: string, siteId: string) {
    if (new URL(value).hostname !== siteId.split(",")[0])
      throw new ConnectorError("CONNECTOR_SITE_MISMATCH");
  }
  async function pages<T>(
    initial: string,
    schema: z.ZodType<T>,
    limit: number,
    signal: AbortSignal,
  ) {
    const expected = new URL(initial),
      seen = new Set<string>(),
      values: T[] = [];
    let next = initial;
    while (next) {
      const u = new URL(next);
      if (
        u.origin !== expected.origin ||
        decodeURIComponent(u.pathname) !==
          decodeURIComponent(expected.pathname) ||
        u.username ||
        u.password ||
        u.hash ||
        seen.has(u.toString()) ||
        seen.size >= 100
      )
        throw new ConnectorError("CONNECTOR_INVALID_LISTING");
      seen.add(u.toString());
      const page = z
        .object({
          value: z.array(schema).max(1000),
          "@odata.nextLink": z.string().min(1).max(16000).optional(),
        })
        .parse(await graph.json(u.toString(), signal));
      values.push(...page.value);
      if (values.length > limit)
        throw new ConnectorError("CONNECTOR_DISCOVERY_LIMIT");
      next = page["@odata.nextLink"] ?? "";
    }
    return values;
  }
  async function site(siteId: string, signal: AbortSignal) {
    sharePointSiteId.parse(siteId);
    const value = siteSchema.parse(
      await graph.json(
        url("/sites/" + siteId, "id,displayName,webUrl"),
        signal,
      ),
    );
    if (value.id !== siteId)
      throw new ConnectorError("CONNECTOR_SITE_MISMATCH");
    sameHost(value.webUrl, siteId);
    return value;
  }
  async function libraries(siteId: string, signal: AbortSignal) {
    await site(siteId, signal);
    const result = await pages(
      url("/sites/" + siteId + "/drives", "id,name,driveType,webUrl", true),
      librarySchema,
      100,
      signal,
    );
    const ids = new Set<string>();
    for (const library of result) {
      if (ids.has(library.id))
        throw new ConnectorError("CONNECTOR_INVALID_LISTING");
      ids.add(library.id);
      sameHost(library.webUrl, siteId);
    }
    return result;
  }
  async function verifyLibrary(
    siteId: string,
    driveId: string,
    signal: AbortSignal,
  ) {
    oneDriveSelection.shape.driveId.parse(driveId);
    if (
      !(await libraries(siteId, signal)).some(
        (library) => library.id === driveId,
      )
    )
      throw new ConnectorError("CONNECTOR_LIBRARY_UNAVAILABLE");
  }
  return {
    resolveSite(input, signal) {
      return safeGraphOperation(async () => {
        const u = new URL(sharePointSiteUrl.parse(input));
        const segments = u.pathname
          .split("/")
          .filter(Boolean)
          .map((segment) => {
            const decoded = decodeURIComponent(segment);
            if (
              decoded === "." ||
              decoded === ".." ||
              /[\\/\\\\:\u0000-\u001f]/.test(decoded)
            )
              throw new ConnectorError("CONNECTOR_SITE_URL_INVALID");
            return encodeURIComponent(decoded);
          });
        const value = siteSchema.parse(
          await graph.json(
            url(
              `/sites/${u.hostname}:/${segments.join("/")}`,
              "id,displayName,webUrl",
            ),
            signal,
          ),
        );
        if (
          value.id.split(",")[0] !== u.hostname ||
          new URL(value.webUrl).hostname !== u.hostname ||
          decodeURIComponent(new URL(value.webUrl).pathname)
            .replace(/\/$/, "")
            .toLowerCase() !==
            decodeURIComponent(u.pathname).replace(/\/$/, "").toLowerCase()
        )
          throw new ConnectorError("CONNECTOR_SITE_MISMATCH");
        return value;
      }, signal);
    },
    libraries(siteId, signal) {
      return safeGraphOperation(() => libraries(siteId, signal), signal);
    },
    verifyLibrary(siteId, driveId, signal) {
      return safeGraphOperation(
        () => verifyLibrary(siteId, driveId, signal),
        signal,
      );
    },
    folders(siteId, driveId, folderId, signal) {
      return safeGraphOperation(async () => {
        await verifyLibrary(siteId, driveId, signal);
        if (folderId) oneDriveSelection.shape.folderId.parse(folderId);
        const path =
          `/drives/${driveId}` + (folderId ? `/items/${folderId}` : "/root");
        const fields =
          "id,name,webUrl,folder,parentReference,remoteItem,deleted";
        const folder = folderSchema.parse(
          await graph.json(url(path, fields), signal),
        );
        if (
          !folder.folder ||
          folder.remoteItem !== undefined ||
          folder.deleted !== undefined ||
          (folderId && folder.id !== folderId) ||
          (folder.parentReference && folder.parentReference.driveId !== driveId)
        )
          throw new ConnectorError("CONNECTOR_FOLDER_UNAVAILABLE");
        sameHost(folder.webUrl, siteId);
        const entries = await pages(
          url(`/drives/${driveId}/items/${folder.id}/children`, fields, true),
          folderSchema,
          1000,
          signal,
        );
        const ids = new Set<string>(),
          folders: SharePointFolder[] = [];
        for (const entry of entries) {
          if (ids.has(entry.id) || entry.deleted !== undefined)
            throw new ConnectorError("CONNECTOR_INVALID_LISTING");
          ids.add(entry.id);
          if (entry.remoteItem !== undefined) continue;
          if (
            entry.parentReference?.driveId !== driveId ||
            entry.parentReference?.id !== folder.id
          )
            throw new ConnectorError("CONNECTOR_INVALID_LISTING");
          if (!entry.folder) continue;
          sameHost(entry.webUrl, siteId);
          folders.push({
            id: entry.id,
            name: entry.name,
            webUrl: entry.webUrl,
          });
        }
        return {
          folder: { id: folder.id, name: folder.name, webUrl: folder.webUrl },
          folders,
        };
      }, signal);
    },
    close() {
      graph.close();
    },
  };
}
export function createSharePointAdapter(
  selection: z.infer<typeof sharePointSelection>,
  credential: z.infer<typeof oneDriveCredential>,
  transport?: GraphTransport,
): SourceAdapter {
  const graph = createMicrosoftGraphClient(credential, transport);
  const client = createSharePointClient(credential, transport, graph);
  const adapter = createOneDriveAdapter(
    oneDriveSelection.parse({
      driveId: selection.driveId,
      folderId: selection.folderId,
      recursive: selection.recursive,
      maxObjects: selection.maxObjects,
    }),
    credential,
    transport,
    graph,
  );
  return {
    async list(signal) {
      await client.verifyLibrary(selection.siteId, selection.driveId, signal);
      const result = await adapter.list(signal);
      await client.verifyLibrary(selection.siteId, selection.driveId, signal);
      return result;
    },
    read(document, signal) {
      return adapter.read(document, signal);
    },
    close() {
      client.close();
      adapter.close();
    },
  };
}
