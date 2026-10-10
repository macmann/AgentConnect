import { randomUUID, createHash } from "node:crypto";
import type { GraphTransport } from "../src/microsoft-graph-client.js";
export function createSharePointFixture() {
  const site = {
    id: `fixture.sharepoint.com,${randomUUID()},${randomUUID()}`,
    displayName: "Support site",
    webUrl: "https://fixture.sharepoint.com/sites/Support",
  };
  const library = {
    id: "b!support-library",
    name: "Documents",
    driveType: "documentLibrary" as const,
    webUrl: site.webUrl + "/Documents",
  };
  const state = {
    linked: true,
    visible: true,
    denied: false,
    wrongSite: false,
    wrongParent: false,
    libraryCount: 1,
    libraryNext: "",
    folderNext: "",
    content: "SharePoint refunds within 30 days.",
    version: 1,
  };
  const requests: {
    url: string;
    method?: string;
    authorization?: string;
    form?: string;
  }[] = [];
  const base = {
    size: 0,
    eTag: '"folder-1"',
    lastModifiedDateTime: "2026-10-10T00:00:00Z",
  };
  const root = {
    ...base,
    id: "root-folder",
    name: "Documents",
    webUrl: library.webUrl,
    folder: { childCount: 1 },
    parentReference: { driveId: library.id },
  };
  const policies = {
    ...base,
    id: "policies-folder",
    name: "Policies",
    webUrl: library.webUrl + "/Policies",
    folder: { childCount: 1 },
    parentReference: { driveId: library.id, id: root.id },
  };
  function file() {
    const bytes = Buffer.from(state.content);
    return {
      id: "policy",
      name: "policy.txt",
      size: bytes.length,
      eTag: `"file-${state.version}"`,
      lastModifiedDateTime: "2026-10-10T00:00:00Z",
      webUrl: policies.webUrl + "/policy.txt",
      file: {
        hashes: {
          sha256Hash: createHash("sha256").update(bytes).digest("hex"),
        },
      },
      parentReference: {
        driveId: library.id,
        id: state.wrongParent ? "foreign-folder" : policies.id,
      },
    };
  }
  const transport: GraphTransport = async (
    raw,
    headers,
    body,
    signal,
    method,
  ) => {
    signal.throwIfAborted();
    const u = new URL(raw),
      path = decodeURIComponent(u.pathname);
    requests.push({
      url: raw,
      method,
      authorization: headers.authorization,
      ...(method === "POST" ? { form: String(body) } : {}),
    });
    const value =
      u.hostname === "login.microsoftonline.com"
        ? {
            access_token: "sharepoint-fixture-token",
            token_type: "Bearer",
            expires_in: 3600,
          }
        : path.endsWith("/sites/fixture.sharepoint.com:/sites/Support") ||
            path.endsWith("/sites/" + site.id)
          ? {
              ...site,
              id: state.wrongSite
                ? `foreign.sharepoint.com,${randomUUID()},${randomUUID()}`
                : site.id,
            }
          : path.endsWith("/sites/" + site.id + "/drives")
            ? {
                value: state.linked
                  ? Array.from({ length: state.libraryCount }, (_, i) =>
                      i ? { ...library, id: `library-${i}` } : library,
                    )
                  : [],
                ...(state.libraryNext
                  ? { "@odata.nextLink": state.libraryNext }
                  : {}),
              }
            : path.endsWith("/drives/" + library.id)
              ? { id: library.id, driveType: "documentLibrary" }
              : path.endsWith("/root") || path.endsWith("/items/" + root.id)
                ? root
                : path.endsWith("/items/" + policies.id)
                  ? policies
                  : path.endsWith("/items/" + root.id + "/children")
                    ? {
                        value: [
                          policies,
                          {
                            ...file(),
                            id: "shortcut",
                            remoteItem: { id: "remote" },
                          },
                        ],
                        ...(state.folderNext
                          ? { "@odata.nextLink": state.folderNext }
                          : {}),
                      }
                    : path.endsWith("/items/" + policies.id + "/children")
                      ? { value: state.visible ? [file()] : [] }
                      : path.endsWith("/items/policy/content")
                        ? Buffer.from(state.content)
                        : path.endsWith("/items/policy")
                          ? file()
                          : undefined;
    if (value === undefined)
      throw new Error("Unexpected SharePoint fixture path");
    return {
      status:
        state.denied && u.hostname !== "login.microsoftonline.com" ? 403 : 200,
      headers: {},
      body: (async function* () {
        yield Buffer.isBuffer(value)
          ? value
          : Buffer.from(JSON.stringify(value));
      })(),
      close: async () => {},
    };
  };
  return { site, library, root, policies, state, requests, transport };
}
