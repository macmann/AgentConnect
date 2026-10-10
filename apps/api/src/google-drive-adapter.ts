import { createSign, createHash } from "node:crypto";
import { z } from "zod";
import { safeHttpTransport, ProviderError } from "@agentconnect/provider-sdk";
import {
  googleDriveSelection,
  googleDriveCredential,
} from "@agentconnect/schemas/connectors";
import {
  ConnectorError,
  type SourceAdapter,
  type RemoteDocument,
} from "./connector-adapters.js";
import { config } from "./config.js";
import { hosts } from "./knowledge-core.js";
export const googleDriveEndpoints = [
  "https://www.googleapis.com/drive/v3",
  "https://oauth2.googleapis.com/token",
];
const folderMime = "application/vnd.google-apps.folder";
const exportsByMime: Record<string, { mime: string; extension: string }> = {
  "application/vnd.google-apps.document": {
    mime: "text/plain",
    extension: "txt",
  },
  "application/vnd.google-apps.spreadsheet": {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  },
  "application/vnd.google-apps.presentation": {
    mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    extension: "pptx",
  },
};
const fileSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/),
  name: z.string().min(1).max(1000),
  mimeType: z.string().min(1).max(200),
  version: z.string().regex(/^\d+$/),
  modifiedTime: z.iso.datetime({ offset: true }),
  size: z.string().regex(/^\d+$/).optional(),
  md5Checksum: z
    .string()
    .regex(/^[a-fA-F0-9]{32}$/)
    .optional(),
  parents: z.array(z.string()).max(100).default([]),
  trashed: z.boolean(),
});
type File = z.infer<typeof fileSchema>;
const fields =
  "id,name,mimeType,version,modifiedTime,size,md5Checksum,parents,trashed";
const fingerprint = (f: File) =>
  JSON.stringify([
    f.id,
    f.version,
    f.modifiedTime,
    f.name,
    f.mimeType,
    f.size,
    f.md5Checksum,
    [...f.parents].sort(),
  ]);
export function createGoogleDriveAdapter(
  selection: z.infer<typeof googleDriveSelection>,
  credential: z.infer<typeof googleDriveCredential>,
  transport: ReturnType<typeof safeHttpTransport> = safeHttpTransport(
    hosts(config.CONNECTOR_ALLOWED_HOSTS),
    hosts(config.CONNECTOR_PRIVATE_HOSTS),
  ),
): SourceAdapter {
  let token = "",
    expiresAt = 0;
  const listed = new Map<string, File>();
  async function request(url: string, signal: AbortSignal, body?: string) {
    const response = await transport(
      url,
      body === undefined
        ? { authorization: `Bearer ${token}` }
        : { "content-type": "application/x-www-form-urlencoded" },
      body ?? null,
      signal,
      body === undefined ? "GET" : "POST",
    );
    try {
      if (response.status < 200 || response.status >= 300) {
        throw new ConnectorError(
          response.status === 401 || response.status === 403
            ? "CONNECTOR_ACCESS_DENIED"
            : response.status === 404
              ? "CONNECTOR_NOT_FOUND"
              : response.status === 429
                ? "CONNECTOR_RATE_LIMITED"
                : "CONNECTOR_PROVIDER_ERROR",
        );
      }
      let length = 0;
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.body) {
        signal.throwIfAborted();
        length += chunk.byteLength;
        if (length > 10000000)
          throw new ConnectorError("CONNECTOR_OBJECT_LIMIT");
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } finally {
      await response.close();
    }
  }
  async function json(
    url: string,
    signal: AbortSignal,
    body?: string,
  ): Promise<unknown> {
    try {
      return JSON.parse((await request(url, signal, body)).toString("utf8"));
    } catch (e) {
      if (e instanceof SyntaxError)
        throw new ConnectorError("CONNECTOR_INVALID_LISTING");
      throw e;
    }
  }
  async function authenticate(signal: AbortSignal) {
    if (token && expiresAt > Date.now() + 60000) return;
    const now = Math.floor(Date.now() / 1000);
    const encode = (v: unknown) =>
      Buffer.from(JSON.stringify(v)).toString("base64url");
    const input =
      encode({ alg: "RS256", typ: "JWT" }) +
      "." +
      encode({
        iss: credential.client_email,
        scope: "https://www.googleapis.com/auth/drive.readonly",
        aud: googleDriveEndpoints[1],
        iat: now,
        exp: now + 3600,
      });
    const signature = createSign("RSA-SHA256")
      .update(input)
      .sign(credential.private_key, "base64url");
    const result = z
      .object({
        access_token: z.string().min(1).max(10000),
        expires_in: z.number().int().min(1).max(86400),
        token_type: z.literal("Bearer"),
      })
      .parse(
        await json(
          googleDriveEndpoints[1]!,
          signal,
          new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: input + "." + signature,
          }).toString(),
        ),
      );
    token = result.access_token;
    expiresAt = Date.now() + result.expires_in * 1000;
  }
  function url(path: string, parameters: Record<string, string>) {
    return (
      googleDriveEndpoints[0] + path + "?" + new URLSearchParams(parameters)
    );
  }
  async function metadata(id: string, signal: AbortSignal) {
    await authenticate(signal);
    return fileSchema.parse(
      await json(
        url("/files/" + id, { fields, supportsAllDrives: "true" }),
        signal,
      ),
    );
  }
  async function safe<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (error instanceof ProviderError)
        throw new ConnectorError(
          error.code === "CANCELLED"
            ? "CONNECTOR_CANCELLED"
            : "CONNECTOR_NETWORK_ERROR",
        );
      if (error instanceof z.ZodError)
        throw new ConnectorError("CONNECTOR_INVALID_LISTING");
      throw new ConnectorError("CONNECTOR_PROVIDER_ERROR");
    }
  }
  return {
    list(signal) {
      return safe(async () => {
        listed.clear();
        const root = await metadata(selection.folderId, signal);
        if (
          root.id !== selection.folderId ||
          root.trashed ||
          root.mimeType !== folderMime
        )
          throw new ConnectorError("CONNECTOR_FOLDER_UNAVAILABLE");
        const folders = [root.id],
          seen = new Set<string>([root.id]);
        const documents: RemoteDocument[] = [];
        let count = 0;
        for (let index = 0; index < folders.length; index++) {
          const parent = folders[index]!;
          let pageToken = "";
          const tokens = new Set<string>();
          do {
            await authenticate(signal);
            const page = z
              .object({
                files: z.array(fileSchema).max(1000),
                nextPageToken: z.string().min(1).max(10000).optional(),
                incompleteSearch: z.boolean().optional(),
              })
              .parse(
                await json(
                  url("/files", {
                    q: `'${parent}' in parents and trashed = false`,
                    fields: `nextPageToken,incompleteSearch,files(${fields})`,
                    pageSize: "100",
                    spaces: "drive",
                    includeItemsFromAllDrives: "true",
                    supportsAllDrives: "true",
                    ...(pageToken ? { pageToken } : {}),
                  }),
                  signal,
                ),
              );
            if (page.incompleteSearch)
              throw new ConnectorError("CONNECTOR_INCOMPLETE_LISTING");
            for (const file of page.files) {
              if (
                seen.has(file.id) ||
                file.trashed ||
                !file.parents.includes(parent)
              )
                throw new ConnectorError("CONNECTOR_INVALID_LISTING");
              seen.add(file.id);
              if (++count > selection.maxObjects)
                throw new ConnectorError("CONNECTOR_SOURCE_LIMIT");
              if (file.mimeType === folderMime) {
                if (selection.recursive) folders.push(file.id);
                continue;
              }
              const format = exportsByMime[file.mimeType];
              const size =
                file.size === undefined ? undefined : Number(file.size);
              if (size !== undefined && !Number.isSafeInteger(size))
                throw new ConnectorError("CONNECTOR_INVALID_LISTING");
              // Unsupported Google-native files and shortcuts are never followed.
              if (
                !format &&
                file.mimeType.startsWith("application/vnd.google-apps.")
              )
                continue;
              if (!format && (size === undefined || !file.md5Checksum))
                throw new ConnectorError("CONNECTOR_INVALID_LISTING");
              listed.set(file.id, file);
              documents.push({
                key: file.id,
                fingerprint: fingerprint(file),
                filename: format
                  ? file.name + "." + format.extension
                  : file.name,
                ...(format ? {} : { size }),
                url: `https://drive.google.com/file/d/${file.id}/view`,
              });
            }
            pageToken = page.nextPageToken ?? "";
            if (pageToken && tokens.has(pageToken))
              throw new ConnectorError("CONNECTOR_INVALID_LISTING");
            if (pageToken) tokens.add(pageToken);
          } while (pageToken);
        }
        // Loss of access to the selected folder cannot masquerade as an empty listing.
        const currentRoot = await metadata(root.id, signal);
        if (currentRoot.trashed || currentRoot.mimeType !== folderMime)
          throw new ConnectorError("CONNECTOR_FOLDER_UNAVAILABLE");
        return documents;
      });
    },
    read(document, signal) {
      return safe(async () => {
        const original = listed.get(document.key);
        if (!original || document.fingerprint !== fingerprint(original))
          throw new ConnectorError("CONNECTOR_OBJECT_CHANGED");
        const before = await metadata(document.key, signal);
        if (before.trashed || fingerprint(before) !== document.fingerprint)
          throw new ConnectorError("CONNECTOR_OBJECT_CHANGED");
        const format = exportsByMime[original.mimeType];
        const bytes = await request(
          url(
            "/files/" + document.key + (format ? "/export" : ""),
            format
              ? { mimeType: format.mime }
              : { alt: "media", supportsAllDrives: "true" },
          ),
          signal,
        );
        if (
          !format &&
          (bytes.length !== document.size ||
            createHash("md5").update(bytes).digest("hex") !==
              original.md5Checksum?.toLowerCase())
        )
          throw new ConnectorError("CONNECTOR_OBJECT_CHANGED");
        const after = await metadata(document.key, signal);
        if (after.trashed || fingerprint(after) !== document.fingerprint)
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
