import { createHash } from "node:crypto";
import { z } from "zod";
import {
  safeHttpTransport,
  ProviderError,
  validateEndpoint,
} from "@agentconnect/provider-sdk";
import {
  oneDriveSelection,
  oneDriveCredential,
} from "@agentconnect/schemas/connectors";
import {
  ConnectorError,
  type SourceAdapter,
  type RemoteDocument,
} from "./connector-adapters.js";
import { config } from "./config.js";
import { hosts } from "./knowledge-core.js";
export const oneDriveEndpoints = [
  "https://graph.microsoft.com/v1.0",
  "https://login.microsoftonline.com",
];
const safeWebUrl = z
  .url()
  .max(2000)
  .refine((value) => {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password;
  });
const itemSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9!_-]{1,200}$/),
  name: z.string().min(1).max(1000),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  eTag: z.string().min(1).max(1000).optional(),
  cTag: z.string().min(1).max(1000).optional(),
  lastModifiedDateTime: z.iso.datetime({ offset: true }),
  webUrl: safeWebUrl,
  parentReference: z
    .object({
      driveId: z.string().min(1).max(200),
      id: z.string().max(200).optional(),
    })
    .optional(),
  folder: z
    .object({ childCount: z.number().int().nonnegative().optional() })
    .optional(),
  file: z
    .object({
      mimeType: z.string().max(200).optional(),
      hashes: z
        .object({
          sha256Hash: z
            .string()
            .regex(/^[a-fA-F0-9]{64}$/)
            .optional(),
          sha1Hash: z
            .string()
            .regex(/^[a-fA-F0-9]{40}$/)
            .optional(),
        })
        .optional(),
    })
    .optional(),
  remoteItem: z.unknown().optional(),
  deleted: z.unknown().optional(),
});
type Item = z.infer<typeof itemSchema>;
const fields =
  "id,name,size,eTag,cTag,lastModifiedDateTime,webUrl,parentReference,folder,file,remoteItem,deleted";
const fingerprint = (item: Item) =>
  JSON.stringify([
    item.id,
    item.name,
    item.size,
    item.eTag,
    item.cTag,
    item.lastModifiedDateTime,
    item.webUrl,
    item.parentReference,
    item.file?.hashes,
  ]);
export function createOneDriveAdapter(
  selection: z.infer<typeof oneDriveSelection>,
  credential: z.infer<typeof oneDriveCredential>,
  transport?: ReturnType<typeof safeHttpTransport>,
): SourceAdapter {
  const requestTransport =
    transport ??
    safeHttpTransport(
      hosts(config.CONNECTOR_ALLOWED_HOSTS),
      hosts(config.CONNECTOR_PRIVATE_HOSTS),
    );
  const downloadTransport =
    transport ?? safeHttpTransport(hosts(config.CONNECTOR_ALLOWED_HOSTS), []);
  let token = "",
    expiresAt = 0;
  const listed = new Map<string, Item>();
  const drivePath = `/drives/${selection.driveId}`;
  const graphUrl = (path: string, query: Record<string, string> = {}) =>
    oneDriveEndpoints[0] +
    drivePath +
    path +
    (Object.keys(query).length ? "?" + new URLSearchParams(query) : "");
  function statusError(status: number): never {
    throw new ConnectorError(
      status === 401 || status === 403
        ? "CONNECTOR_ACCESS_DENIED"
        : status === 404
          ? "CONNECTOR_NOT_FOUND"
          : status === 412
            ? "CONNECTOR_OBJECT_CHANGED"
            : status === 429
              ? "CONNECTOR_RATE_LIMITED"
              : "CONNECTOR_PROVIDER_ERROR",
    );
  }
  async function consume(
    response: Awaited<ReturnType<typeof requestTransport>>,
    signal: AbortSignal,
  ) {
    if (response.status < 200 || response.status >= 300)
      statusError(response.status);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.byteLength;
      if (size > 10000000) throw new ConnectorError("CONNECTOR_OBJECT_LIMIT");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function json(
    url: string,
    signal: AbortSignal,
    form?: string,
  ): Promise<unknown> {
    const response = await requestTransport(
      url,
      form === undefined
        ? { authorization: `Bearer ${token}` }
        : { "content-type": "application/x-www-form-urlencoded" },
      form ?? null,
      signal,
      form === undefined ? "GET" : "POST",
    );
    try {
      try {
        return JSON.parse((await consume(response, signal)).toString("utf8"));
      } catch (e) {
        if (e instanceof SyntaxError)
          throw new ConnectorError("CONNECTOR_INVALID_LISTING");
        throw e;
      }
    } finally {
      await response.close();
    }
  }
  async function authenticate(signal: AbortSignal) {
    if (token && expiresAt > Date.now() + 60000) return;
    const result = z
      .object({
        access_token: z.string().min(1).max(30000),
        expires_in: z.number().int().min(1).max(86400),
        token_type: z.literal("Bearer"),
      })
      .parse(
        await json(
          `${oneDriveEndpoints[1]}/${credential.tenantId}/oauth2/v2.0/token`,
          signal,
          new URLSearchParams({
            client_id: credential.clientId,
            client_secret: credential.clientSecret,
            scope: "https://graph.microsoft.com/.default",
            grant_type: "client_credentials",
          }).toString(),
        ),
      );
    token = result.access_token;
    expiresAt = Date.now() + result.expires_in * 1000;
  }
  async function metadata(id: string, signal: AbortSignal) {
    await authenticate(signal);
    const item = itemSchema.parse(
      await json(graphUrl(`/items/${id}`, { $select: fields }), signal),
    );
    if (
      item.id !== id ||
      item.deleted !== undefined ||
      item.remoteItem !== undefined ||
      (item.parentReference &&
        item.parentReference.driveId !== selection.driveId)
    )
      throw new ConnectorError("CONNECTOR_OBJECT_CHANGED");
    return item;
  }
  function nextPage(value: string, parent: string) {
    const expected = new URL(graphUrl(`/items/${parent}/children`));
    const u = new URL(value);
    if (
      u.origin !== expected.origin ||
      decodeURIComponent(u.pathname) !==
        decodeURIComponent(expected.pathname) ||
      u.username ||
      u.password ||
      u.hash
    )
      throw new ConnectorError("CONNECTOR_INVALID_LISTING");
    return u.toString();
  }
  async function download(item: Item, signal: AbortSignal) {
    await authenticate(signal);
    const response = await requestTransport(
      graphUrl(`/items/${item.id}/content`),
      { authorization: `Bearer ${token}`, "if-match": item.eTag! },
      null,
      signal,
      "GET",
    );
    let location: string | undefined;
    try {
      if (response.status === 302) {
        const value = response.headers?.location;
        if (typeof value !== "string" || value.length > 16000)
          throw new ConnectorError("CONNECTOR_DOWNLOAD_ENDPOINT_NOT_ALLOWED");
        location = value;
      } else {
        return await consume(response, signal);
      }
    } finally {
      await response.close();
    }
    // Preauthenticated download URLs are temporary credentials: never persist them,
    // send Graph authorization to them, or follow further redirects.
    try {
      const u = new URL(location!);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.hash ||
        (u.port && u.port !== "443")
      )
        throw new Error("Invalid download URL");
      validateEndpoint(
        u.origin + u.pathname,
        hosts(config.CONNECTOR_ALLOWED_HOSTS),
        [],
      );
    } catch {
      throw new ConnectorError("CONNECTOR_DOWNLOAD_ENDPOINT_NOT_ALLOWED");
    }
    const result = await downloadTransport(location!, {}, null, signal, "GET");
    try {
      return await consume(result, signal);
    } finally {
      await result.close();
    }
  }
  async function safe<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ConnectorError) throw e;
      if (e instanceof ProviderError)
        throw new ConnectorError(
          e.code === "CANCELLED"
            ? "CONNECTOR_CANCELLED"
            : "CONNECTOR_NETWORK_ERROR",
        );
      if (e instanceof z.ZodError || e instanceof TypeError)
        throw new ConnectorError("CONNECTOR_INVALID_LISTING");
      throw new ConnectorError("CONNECTOR_PROVIDER_ERROR");
    }
  }
  return {
    list(signal) {
      return safe(async () => {
        listed.clear();
        await authenticate(signal);
        const drive = z
          .object({
            id: z.string(),
            driveType: z.enum(["business", "documentLibrary", "personal"]),
          })
          .parse(await json(graphUrl("", { $select: "id,driveType" }), signal));
        if (drive.id !== selection.driveId || drive.driveType === "personal")
          throw new ConnectorError("CONNECTOR_DRIVE_UNSUPPORTED");
        const root = await metadata(selection.folderId, signal);
        if (!root.folder)
          throw new ConnectorError("CONNECTOR_FOLDER_UNAVAILABLE");
        const folders = [root.id],
          seen = new Set<string>([root.id]),
          docs: RemoteDocument[] = [];
        let count = 0;
        for (let index = 0; index < folders.length; index++) {
          const parent = folders[index]!;
          let pageUrl = graphUrl(`/items/${parent}/children`, {
            $select: fields,
            $top: "100",
          });
          const pages = new Set<string>();
          while (pageUrl) {
            signal.throwIfAborted();
            if (pages.has(pageUrl) || pages.size >= 1000)
              throw new ConnectorError("CONNECTOR_INVALID_LISTING");
            pages.add(pageUrl);
            await authenticate(signal);
            const page = z
              .object({
                value: z.array(itemSchema).max(1000),
                "@odata.nextLink": z.string().min(1).max(16000).optional(),
              })
              .parse(await json(pageUrl, signal));
            for (const item of page.value) {
              if (seen.has(item.id) || item.deleted !== undefined)
                throw new ConnectorError("CONNECTOR_INVALID_LISTING");
              seen.add(item.id);
              if (++count > selection.maxObjects)
                throw new ConnectorError("CONNECTOR_SOURCE_LIMIT");
              if (item.remoteItem !== undefined) continue;
              if (
                item.parentReference?.driveId !== selection.driveId ||
                item.parentReference?.id !== parent
              )
                throw new ConnectorError("CONNECTOR_INVALID_LISTING");
              if (item.folder) {
                if (selection.recursive) folders.push(item.id);
                continue;
              }
              if (!item.file) continue;
              if (!item.eTag)
                throw new ConnectorError("CONNECTOR_INVALID_LISTING");
              listed.set(item.id, item);
              docs.push({
                key: item.id,
                filename: item.name,
                size: item.size,
                fingerprint: fingerprint(item),
                etag: item.eTag,
                url: item.webUrl,
              });
            }
            pageUrl = page["@odata.nextLink"]
              ? nextPage(page["@odata.nextLink"]!, parent)
              : "";
          }
        }
        const finalRoot = await metadata(root.id, signal);
        if (!finalRoot.folder)
          throw new ConnectorError("CONNECTOR_FOLDER_UNAVAILABLE");
        return docs;
      });
    },
    read(document, signal) {
      return safe(async () => {
        const original = listed.get(document.key);
        if (!original || document.fingerprint !== fingerprint(original))
          throw new ConnectorError("CONNECTOR_OBJECT_CHANGED");
        const before = await metadata(document.key, signal);
        if (
          fingerprint(before) !== document.fingerprint ||
          !before.file ||
          before.folder
        )
          throw new ConnectorError("CONNECTOR_OBJECT_CHANGED");
        const bytes = await download(before, signal);
        if (bytes.length !== document.size)
          throw new ConnectorError("CONNECTOR_OBJECT_CHANGED");
        const hashes = original.file?.hashes;
        if (
          (hashes?.sha256Hash &&
            createHash("sha256").update(bytes).digest("hex") !==
              hashes.sha256Hash.toLowerCase()) ||
          (hashes?.sha1Hash &&
            createHash("sha1").update(bytes).digest("hex") !==
              hashes.sha1Hash.toLowerCase())
        )
          throw new ConnectorError("CONNECTOR_OBJECT_CHANGED");
        const after = await metadata(document.key, signal);
        if (
          fingerprint(after) !== document.fingerprint ||
          !after.file ||
          after.folder
        )
          throw new ConnectorError("CONNECTOR_OBJECT_CHANGED");
        return bytes;
      });
    },
    close() {
      token = "";
      expiresAt = 0;
      listed.clear();
    },
  };
}
