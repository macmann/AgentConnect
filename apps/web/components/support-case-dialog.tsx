"use client";
import {
  SupportResolutionEditor,
  type ResolutionDraft,
} from "./support-resolution-editor";
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type {
  SupportCaseView,
  SupportQueue,
  SupportCursor,
  SupportPage,
  SupportOperator,
} from "@agentconnect/schemas/support";
import { requestJson } from "./agent-client";
import { Button } from "./button";
import { supportCursor, statusLabel } from "./support-utils";
export function CaseActionDialog({
  action,
  returnToAIEnabled,
  onClose,
  s,
  base,
  workspaceId,
  queues,
  busy,
  onSubmit,
  error,
}: {
  action: "resolve" | "assign" | null;
  returnToAIEnabled: boolean;
  onClose: () => void;
  s: SupportCaseView;
  base: string;
  workspaceId: string;
  queues: SupportQueue[];
  busy: boolean;
  onSubmit: (action: string, body: unknown) => Promise<void>;
  error: string;
}) {
  const [operator, setOperator] = useState(""),
    [queue, setQueue] = useState(s.queue_id ?? ""),
    [code, setCode] = useState("resolved"),
    [summary, setSummary] = useState(""),
    [finalResponse, setFinalResponse] = useState(""),
    [resumeDraft, setResumeDraft] = useState<ResolutionDraft>({
      facts: null,
      error: "",
    });
  const operators = useInfiniteQuery({
    queryKey: ["support", workspaceId, "operators"],
    initialPageParam: null as SupportCursor | null,
    queryFn: ({ pageParam }) =>
      requestJson<SupportPage<SupportOperator>>(
        base + "/operators?limit=50" + supportCursor(pageParam),
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    enabled: action === "assign",
  });
  return (
    <Dialog.Root
      open={!!action}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title>
            {action === "assign"
              ? "Assign support case"
              : returnToAIEnabled
                ? "Resolve and return to AI"
                : "Resolve support case"}
          </Dialog.Title>
          <Dialog.Description>
            {action === "assign"
              ? "Choose an eligible workspace teammate. They must accept the case before replying."
              : "Save the private resolution note and separately approve the facts the AI may use to continue this conversation."}
          </Dialog.Description>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onSubmit(
                action === "assign" ? "assign" : "resolve",
                action === "assign"
                  ? { operatorId: operator, queueId: queue || null }
                  : {
                      code,
                      summary,
                      resume: resumeDraft.facts ?? undefined,
                      finalResponse: finalResponse.trim() || undefined,
                    },
              );
            }}
          >
            {action === "assign" ? (
              <>
                <label>
                  Assign to
                  <select
                    required
                    value={operator}
                    onChange={(e) => setOperator(e.target.value)}
                    disabled={busy || operators.isPending}
                  >
                    <option value="">
                      {operators.isPending
                        ? "Loading operators…"
                        : "Choose an operator"}
                    </option>
                    {operators.data?.pages
                      .flatMap((p) => p.items)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                  </select>
                </label>
                {operators.error && (
                  <p className="error" role="alert">
                    {operators.error.message}{" "}
                    <Button
                      type="button"
                      onClick={() => void operators.refetch()}
                    >
                      Retry operators
                    </Button>
                  </p>
                )}
                {operators.hasNextPage && (
                  <Button
                    className="secondary"
                    type="button"
                    disabled={operators.isFetchingNextPage}
                    onClick={() => void operators.fetchNextPage()}
                  >
                    Load more operators
                  </Button>
                )}
                <label>
                  Assigned queue
                  <select
                    value={queue}
                    disabled={busy}
                    onChange={(e) => setQueue(e.target.value)}
                  >
                    <option value="">No queue</option>
                    {queues
                      .filter((q) => q.enabled || q.id === s.queue_id)
                      .map((q) => (
                        <option key={q.id} value={q.id} disabled={!q.enabled}>
                          {q.name}
                          {q.enabled ? "" : " (disabled)"}
                        </option>
                      ))}
                  </select>
                </label>
              </>
            ) : (
              <>
                <label>
                  Resolution code
                  <select
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    disabled={busy}
                  >
                    {[
                      "resolved",
                      "information_provided",
                      "action_completed",
                      "transferred_external",
                      "duplicate",
                      "customer_left",
                      "unable_to_resolve",
                      "invalid_request",
                    ].map((c) => (
                      <option key={c} value={c}>
                        {statusLabel(c)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Private resolution summary
                  <textarea
                    required
                    rows={4}
                    maxLength={4000}
                    value={summary}
                    onChange={(e) => setSummary(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <label>
                  Final reply to customer (optional)
                  <textarea
                    rows={3}
                    maxLength={4000}
                    value={finalResponse}
                    onChange={(e) => setFinalResponse(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <SupportResolutionEditor
                  path={base + "/cases/" + s.id}
                  busy={busy}
                  onChange={setResumeDraft}
                />
                {resumeDraft.error && (
                  <p className="error" role="alert">
                    {resumeDraft.error}
                  </p>
                )}
              </>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="support-dialog-actions">
              <Button
                disabled={
                  busy ||
                  (action === "assign"
                    ? !operator
                    : !summary.trim() || !!resumeDraft.error)
                }
                type="submit"
              >
                {busy
                  ? "Saving…"
                  : action === "assign"
                    ? "Assign case"
                    : "Confirm resolution"}
              </Button>
              <Dialog.Close asChild>
                <Button type="button" className="secondary" disabled={busy}>
                  Cancel
                </Button>
              </Dialog.Close>
            </div>
          </form>
          <Dialog.Close asChild>
            <button
              className="dialog-close"
              disabled={busy}
              aria-label="Close dialog"
            >
              <X size={18} />
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
