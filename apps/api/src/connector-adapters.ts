import { Readable } from "node:stream";
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import {
  safeHttpTransport,
  validateEndpoint,
  ProviderError,
} from "@agentconnect/provider-sdk";
import {
  s3Selection,
  s3Credential,
  googleDriveSelection,
  googleDriveCredential,
  oneDriveSelection,
  oneDriveCredential,
  sharePointSelection,
} from "@agentconnect/schemas/connectors";
import {
  createGoogleDriveAdapter,
  googleDriveEndpoints,
} from "./google-drive-adapter.js";
import {
  createOneDriveAdapter,
  oneDriveEndpoints,
} from "./onedrive-adapter.js";
import { createSharePointAdapter } from "./sharepoint.js";
import { createPrivateKey } from "node:crypto";
import { sql } from "./db.js";
import { decrypt } from "./security.js";
import { config } from "./config.js";
import { hosts } from "./knowledge-core.js";
export class ConnectorError extends Error {
  constructor(public code: string) {
    super("Connector operation failed");
  }
}
export interface RemoteDocument {
  key: string;
  fingerprint: string;
  size?: number;
  filename: string;
  url: string;
  etag?: string;
}
export interface SourceAdapter {
  list(signal: AbortSignal): Promise<RemoteDocument[]>;
  read(document: RemoteDocument, signal: AbortSignal): Promise<Uint8Array>;
  close(): void;
}
export type ConnectorRow = {
  id: string;
  kind: string;
  workspace_id: string;
  organization_id: string;
  knowledge_base_id: string;
  secret_id: string | null;
  selection: unknown;
  revision: number;
  enabled: boolean;
  archived_at: Date | null;
};
export type AdapterFactory = (
  connector: ConnectorRow,
) => Promise<SourceAdapter>;
export function validateConnectorEndpoint(endpoint: string) {
  try {
    validateEndpoint(
      endpoint,
      hosts(config.CONNECTOR_ALLOWED_HOSTS),
      hosts(config.CONNECTOR_PRIVATE_HOSTS),
    );
  } catch {
    throw new ConnectorError("CONNECTOR_ENDPOINT_NOT_ALLOWED");
  }
}
export async function connectorCredentials(
  connector: Pick<
    ConnectorRow,
    "secret_id" | "workspace_id" | "organization_id"
  >,
  kind = "s3",
) {
  const [s] =
    await sql`SELECT name,ciphertext FROM secrets WHERE id=${connector.secret_id} AND workspace_id=${connector.workspace_id} AND organization_id=${connector.organization_id}`;
  if (!s) throw new ConnectorError("CONNECTOR_CREDENTIAL_UNAVAILABLE");
  try {
    const value = JSON.parse(
      decrypt(
        s.ciphertext,
        `${connector.organization_id}:${connector.workspace_id}:${s.name}`,
      ),
    );
    if (kind === "google-drive") {
      const credential = googleDriveCredential.parse(value);
      const key = createPrivateKey(credential.private_key);
      if (
        key.asymmetricKeyType !== "rsa" ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw new Error("Invalid signing key");
      return credential;
    }
    if (kind === "onedrive" || kind === "sharepoint")
      return oneDriveCredential.parse(value);
    return s3Credential.parse(value);
  } catch {
    throw new ConnectorError("CONNECTOR_CREDENTIAL_INVALID");
  }
}
export function validateConnectorSelection(kind: string, selection: unknown) {
  if (kind === "google-drive") {
    googleDriveSelection.parse(selection);
    for (const endpoint of googleDriveEndpoints)
      validateConnectorEndpoint(endpoint);
  } else if (kind === "onedrive" || kind === "sharepoint") {
    if (kind === "sharepoint") sharePointSelection.parse(selection);
    else oneDriveSelection.parse(selection);
    for (const endpoint of oneDriveEndpoints)
      validateConnectorEndpoint(endpoint);
  } else if (kind === "s3")
    validateConnectorEndpoint(s3Selection.parse(selection).endpoint);
  else throw new ConnectorError("CONNECTOR_UNSUPPORTED");
}
export const createSourceAdapter: AdapterFactory = async (connector) => {
  if (connector.kind === "sharepoint") {
    validateConnectorSelection(connector.kind, connector.selection);
    return createSharePointAdapter(
      sharePointSelection.parse(connector.selection),
      oneDriveCredential.parse(
        await connectorCredentials(connector, connector.kind),
      ),
    );
  }
  if (connector.kind === "onedrive") {
    validateConnectorSelection(connector.kind, connector.selection);
    const credential = oneDriveCredential.parse(
      await connectorCredentials(connector, connector.kind),
    );
    return createOneDriveAdapter(
      oneDriveSelection.parse(connector.selection),
      credential,
    );
  }
  if (connector.kind === "google-drive") {
    validateConnectorSelection(connector.kind, connector.selection);
    const credential = googleDriveCredential.parse(
      await connectorCredentials(connector, connector.kind),
    );
    return createGoogleDriveAdapter(
      googleDriveSelection.parse(connector.selection),
      credential,
    );
  }
  if (connector.kind !== "s3")
    throw new ConnectorError("CONNECTOR_UNSUPPORTED");
  const selection = s3Selection.parse(connector.selection);
  validateConnectorEndpoint(selection.endpoint);
  const credentials = s3Credential.parse(await connectorCredentials(connector));
  const transport = safeHttpTransport(
    hosts(config.CONNECTOR_ALLOWED_HOSTS),
    hosts(config.CONNECTOR_PRIVATE_HOSTS),
  );
  const client = new S3Client({
    endpoint: selection.endpoint,
    region: selection.region,
    forcePathStyle: true,
    credentials,
    maxAttempts: 2,
    requestHandler: {
      async handle(
        request: {
          method: string;
          protocol: string;
          hostname: string;
          port?: number;
          path: string;
          query?: Record<string, string | string[] | null>;
          headers: Record<string, string>;
        },
        options?: { abortSignal?: AbortSignal },
      ) {
        if (request.method !== "GET")
          throw new ConnectorError("CONNECTOR_METHOD_DENIED");
        const u = new URL(
          `${request.protocol}//${request.hostname}${request.port ? ":" + request.port : ""}${request.path}`,
        );
        const encode = (v: string) =>
          encodeURIComponent(v).replace(
            /[!'()*]/g,
            (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
          );
        const pairs: string[] = [];
        for (const [key, value] of Object.entries(request.query ?? {})) {
          for (const v of Array.isArray(value) ? value : [value])
            pairs.push(encode(key) + "=" + encode(v ?? ""));
        }
        u.search = pairs.join("&");
        const response = await transport(
          u.toString(),
          request.headers,
          null,
          options?.abortSignal ?? AbortSignal.timeout(60000),
          "GET",
        );
        try {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > 10000000)
              throw new ConnectorError("CONNECTOR_OBJECT_LIMIT");
            chunks.push(chunk);
          }
          return {
            response: {
              statusCode: response.status,
              headers: Object.fromEntries(
                Object.entries(response.headers ?? {}).map(([k, v]) => [
                  k,
                  Array.isArray(v) ? v.join(",") : (v ?? ""),
                ]),
              ),
              body: Readable.from(Buffer.concat(chunks)),
            },
          };
        } finally {
          await response.close();
        }
      },
    },
  });
  const sanitize = (error: unknown): never => {
    if (error instanceof ConnectorError) throw error;
    if (error instanceof ProviderError)
      throw new ConnectorError(
        error.code === "CANCELLED"
          ? "CONNECTOR_CANCELLED"
          : "CONNECTOR_NETWORK_ERROR",
      );
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      ?.$metadata?.httpStatusCode;
    throw new ConnectorError(
      status === 403 || status === 401
        ? "CONNECTOR_ACCESS_DENIED"
        : status === 404
          ? "CONNECTOR_NOT_FOUND"
          : status === 412
            ? "CONNECTOR_OBJECT_CHANGED"
            : "CONNECTOR_PROVIDER_ERROR",
    );
  };
  return {
    async list(signal) {
      try {
        const docs: RemoteDocument[] = [];
        let token: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await client.send(
            new ListObjectsV2Command({
              Bucket: selection.bucket,
              Prefix: selection.prefix,
              MaxKeys: Math.min(1000, selection.maxObjects + 1),
              ContinuationToken: token,
            }),
            { abortSignal: signal },
          );
          for (const item of page.Contents ?? []) {
            if (!item.Key || item.Key.endsWith("/")) continue;
            if (
              !item.Key.startsWith(selection.prefix) ||
              item.Key.length > 1024 ||
              typeof item.Size !== "number" ||
              item.Size < 0 ||
              !item.ETag
            )
              throw new ConnectorError("CONNECTOR_INVALID_LISTING");
            docs.push({
              key: item.Key,
              size: item.Size,
              filename: item.Key.split("/").pop()!,
              etag: item.ETag,
              fingerprint: JSON.stringify([
                item.ETag,
                item.Size,
                item.LastModified?.toISOString(),
              ]),
              url: `s3://${selection.bucket}/${item.Key}`,
            });
            if (docs.length > selection.maxObjects)
              throw new ConnectorError("CONNECTOR_SOURCE_LIMIT");
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
          if (page.IsTruncated && (!token || seen.has(token)))
            throw new ConnectorError("CONNECTOR_INVALID_LISTING");
          if (token) seen.add(token);
        } while (token);
        return docs;
      } catch (e) {
        return sanitize(e);
      }
    },
    async read(document, signal) {
      try {
        const r = await client.send(
          new GetObjectCommand({
            Bucket: selection.bucket,
            Key: document.key,
            IfMatch: document.etag,
          }),
          { abortSignal: signal },
        );
        if (!r.Body) throw new ConnectorError("CONNECTOR_OBJECT_MISSING");
        const bytes = await r.Body.transformToByteArray();
        if (bytes.length !== document.size || bytes.length > 10000000)
          throw new ConnectorError("CONNECTOR_OBJECT_CHANGED");
        return bytes;
      } catch (e) {
        return sanitize(e);
      }
    },
    close() {
      client.destroy();
    },
  };
};
