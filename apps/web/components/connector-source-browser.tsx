"use client";
import { useState } from "react";
import { requestJson } from "./agent-client";
import { Button } from "./button";
type Listing = {
  items: { id: string; name: string; type: string }[];
  driveId?: string;
  folderId?: string;
  teamId?: string;
  truncated: boolean;
};
export function ConnectorSourceBrowser({
  workspaceId,
  provider,
  secretId,
  onSelect,
}: {
  workspaceId: string;
  provider: string;
  secretId: string;
  onSelect: (value: {
    folderId?: string;
    driveId?: string;
    teamId?: string;
    channelId?: string;
  }) => void;
}) {
  const [listing, setListing] = useState<Listing | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [selected, setSelected] = useState("");
  async function browse(next: Record<string, string> = {}) {
    setBusy(true);
    setError("");
    setSelected("");
    try {
      setListing(
        await requestJson<Listing>(
          `/workspaces/${workspaceId}/connectors/browse`,
          "POST",
          { provider, secretId, ...next },
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to browse source");
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="workspace-advanced-settings">
      <summary>2. Choose a folder or channel</summary>
      <p>
        Browse sources your signed-in account can access. You can also enter
        exact source IDs below.
      </p>
      <Button disabled={busy || !secretId} onClick={() => void browse()}>
        {busy ? "Loading…" : "Browse sources"}
      </Button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {listing && (
        <>
          <label>
            Available sources
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">Select a source</option>
              {listing.items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          {listing.items.length === 0 && (
            <p>
              No matching sources here. Check account access or enter a source
              ID.
            </p>
          )}
          {listing.truncated && (
            <p role="status">
              Showing the first 100 results. Use an exact source ID if your
              source is not listed.
            </p>
          )}
          {listing.folderId && (
            <Button
              disabled={busy}
              onClick={() =>
                onSelect({
                  folderId: listing.folderId,
                  driveId: listing.driveId,
                })
              }
            >
              Use current folder
            </Button>
          )}
          <Button
            disabled={busy || !selected}
            onClick={() => {
              const item = listing.items.find((i) => i.id === selected);
              if (item?.type === "team") void browse({ teamId: selected });
              else if (item?.type === "folder")
                void browse({
                  folderId: selected,
                  ...(listing.driveId ? { driveId: listing.driveId } : {}),
                });
              else onSelect({ teamId: listing.teamId, channelId: selected });
            }}
          >
            {listing.items.find((i) => i.id === selected)?.type === "channel"
              ? "Use channel"
              : "Open selected source"}
          </Button>
        </>
      )}
    </details>
  );
}
