import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { safeHttpTransport } from "@agentconnect/provider-sdk";
import {
  oauthProvider,
  oauthAccessCredential,
} from "@agentconnect/schemas/connectors";
import { actor, workspaceAccess, id, params } from "./app.js";
import {
  connectorCredentials,
  validateConnectorEndpoint,
  ConnectorError,
} from "./connector-adapters.js";
import { config } from "./config.js";
import { hosts } from "./knowledge-core.js";
import { HttpError } from "./http-error.js";
import { createMicrosoftGraphClient } from "./microsoft-graph-client.js";
const segment = z.string().regex(/^[a-zA-Z0-9!_-]{1,200}$/);
export async function registerConnectorDiscovery(
  app: FastifyInstance,
  suppliedHttp?: ReturnType<typeof safeHttpTransport>,
) {
  app.post(
    "/workspaces/:workspaceId/connectors/browse",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (r) => {
      const u = await actor(r),
        w = await workspaceAccess(
          u.id,
          id(params(r).workspaceId),
          "connector:manage",
        );
      const d = z
        .object({
          provider: oauthProvider,
          secretId: z.uuid(),
          folderId: segment.optional(),
          driveId: segment.optional(),
          teamId: segment.optional(),
        })
        .strict()
        .parse(r.body);
      const credential = await connectorCredentials(
          {
            secret_id: d.secretId,
            workspace_id: w.id,
            organization_id: w.organization_id,
          },
          d.provider,
        ),
        signal = AbortSignal.timeout(30000);
      if (d.provider === "sharepoint")
        throw new HttpError(
          400,
          "Use the SharePoint site and library browser.",
        );
      const http =
        suppliedHttp ??
        safeHttpTransport(
          hosts(config.CONNECTOR_ALLOWED_HOSTS),
          hosts(config.CONNECTOR_PRIVATE_HOSTS),
        );
      async function json(url: string, token: string) {
        const endpoint = new URL(url);
        validateConnectorEndpoint(endpoint.origin + endpoint.pathname);
        const response = await http(
          url,
          { authorization: `Bearer ${token}` },
          null,
          signal,
          "GET",
        );
        try {
          if (response.status !== 200)
            throw new ConnectorError("CONNECTOR_ACCESS_DENIED");
          let size = 0;
          const chunks: Uint8Array[] = [];
          for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > 1000000)
              throw new ConnectorError("CONNECTOR_OBJECT_LIMIT");
            chunks.push(chunk);
          }
          return JSON.parse(Buffer.concat(chunks).toString()) as Record<
            string,
            unknown
          >;
        } finally {
          await response.close();
        }
      }
      if (d.provider === "google-drive") {
        const auth = oauthAccessCredential.safeParse(credential);
        if (!auth.success)
          throw new HttpError(
            409,
            "Sign in with Google to browse; service-account sources can use folder IDs.",
          );
        const parent = d.folderId ?? "root";
        const result = await json(
          "https://www.googleapis.com/drive/v3/files?" +
            new URLSearchParams({
              q: `'${parent}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'`,
              fields: "files(id,name),nextPageToken",
              pageSize: "100",
              supportsAllDrives: "true",
              includeItemsFromAllDrives: "true",
            }),
          auth.data.accessToken,
        );
        const page = z
          .object({
            files: z
              .array(z.object({ id: segment, name: z.string().max(1000) }))
              .max(100),
            nextPageToken: z.string().optional(),
          })
          .parse(result);
        return {
          items: page.files.map((f) => ({ ...f, type: "folder" })),
          folderId: parent,
          truncated: !!page.nextPageToken,
        };
      }
      if (d.provider === "slack") {
        const auth = z.object({ token: z.string() }).parse(credential);
        const result = z
          .object({
            ok: z.boolean(),
            channels: z
              .array(
                z.object({
                  id: z.string().regex(/^[CG][A-Z0-9]{2,30}$/),
                  name: z.string().max(1000),
                  is_member: z.boolean().optional(),
                }),
              )
              .optional(),
            response_metadata: z
              .object({ next_cursor: z.string().optional() })
              .optional(),
          })
          .parse(
            await json(
              "https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=100",
              auth.token,
            ),
          );
        if (!result.ok) throw new ConnectorError("CONNECTOR_ACCESS_DENIED");
        const identity = z
          .object({
            ok: z.boolean(),
            team_id: z.string().regex(/^T[A-Z0-9]{2,30}$/),
          })
          .parse(await json("https://slack.com/api/auth.test", auth.token));
        if (!identity.ok) throw new ConnectorError("CONNECTOR_ACCESS_DENIED");
        return {
          items: (result.channels ?? [])
            .filter((c) => c.is_member)
            .map((c) => ({ id: c.id, name: c.name, type: "channel" })),
          teamId: identity.team_id,
          truncated: !!result.response_metadata?.next_cursor,
        };
      }
      const graph = createMicrosoftGraphClient(
        credential as Parameters<typeof createMicrosoftGraphClient>[0],
        http,
      );
      try {
        const root = "https://graph.microsoft.com/v1.0";
        if (d.provider === "teams") {
          const result = z
            .object({
              value: z
                .array(
                  z.object({
                    id: z.string().regex(/^[a-zA-Z0-9:_@.-]{1,200}$/),
                    displayName: z.string().max(1000),
                  }),
                )
                .max(1000),
              "@odata.nextLink": z.string().optional(),
            })
            .parse(
              await graph.json(
                d.teamId
                  ? `${root}/teams/${d.teamId}/channels`
                  : `${root}/me/joinedTeams`,
                signal,
              ),
            );
          return {
            items: result.value.slice(0, 100).map((item) => ({
              id: item.id,
              name: item.displayName,
              type: d.teamId ? "channel" : "team",
            })),
            teamId: d.teamId,
            truncated: !!result["@odata.nextLink"] || result.value.length > 100,
          };
        }
        const driveId =
          d.driveId ??
          z
            .object({ id: segment })
            .parse(await graph.json(root + "/me/drive?$select=id", signal)).id;
        const folder =
          d.folderId ??
          z
            .object({ id: segment })
            .parse(
              await graph.json(
                `${root}/drives/${driveId}/root?$select=id`,
                signal,
              ),
            ).id;
        const result = z
          .object({
            value: z
              .array(
                z.object({
                  id: segment,
                  name: z.string().max(1000),
                  folder: z.unknown().optional(),
                  remoteItem: z.unknown().optional(),
                }),
              )
              .max(100),
            "@odata.nextLink": z.string().optional(),
          })
          .parse(
            await graph.json(
              `${root}/drives/${driveId}/items/${folder}/children?$select=id,name,folder,remoteItem&$top=100`,
              signal,
            ),
          );
        return {
          items: result.value
            .filter((i) => i.folder !== undefined && i.remoteItem === undefined)
            .map((i) => ({ id: i.id, name: i.name, type: "folder" })),
          driveId,
          folderId: folder,
          truncated: !!result["@odata.nextLink"] || result.value.length > 100,
        };
      } finally {
        graph.close();
      }
    },
  );
}
