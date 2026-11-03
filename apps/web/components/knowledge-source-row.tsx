"use client";
import { useRef, useState } from "react";
import * as Menu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Ellipsis,
  X,
  AlertTriangle,
  Settings2,
  Eye,
  Pencil,
  Trash2,
  RefreshCw,
  Layers,
  FileSearch,
  Activity,
} from "lucide-react";
import type { Source } from "./knowledge-studio";
import { SourceMetadataEditor } from "./knowledge-metadata";
import {
  TaggingRequest,
  SuggestionReview,
  type TaggingJob,
} from "./knowledge-bulk-metadata";
import {
  processingChanged,
  type ProcessingSettings,
} from "./advanced-knowledge-settings";
import { WorkspaceRecordLink } from "./workspace-record-link";
import { Button } from "./button";

type Props = {
  source: Source;
  workspaceId: string;
  path: string;
  canManage: boolean;
  busy: boolean;
  selected: boolean;
  selectionDisabled: boolean;
  onSelected: (checked: boolean) => void;
  models: { id: string; name: string }[];
  taggingJobs: TaggingJob[];
  baseProcessing: ProcessingSettings;
  onMetadataSaved: () => Promise<unknown>;
  onTaggingQueued: () => Promise<unknown>;
  onInspect: () => void;
  onExtraction: () => void;
  onUsage: () => void;
  onEdit: () => void;
  onReingest: () => void;
  onRemove: () => void;
};
export function KnowledgeSourceRow({
  source: s,
  workspaceId,
  path,
  canManage,
  busy,
  selected,
  selectionDisabled,
  onSelected,
  models,
  taggingJobs,
  baseProcessing,
  onMetadataSaved,
  onTaggingQueued,
  onInspect,
  onExtraction,
  onUsage,
  onEdit,
  onReingest,
  onRemove,
}: Props) {
  const [dialog, setDialog] = useState<"details" | "advanced" | null>(null),
    [section, setSection] = useState<"metadata" | "ai">("metadata"),
    [editorState, setEditorState] = useState({ dirty: false, busy: false });
  const trigger = useRef<HTMLButtonElement>(null),
    opener = useRef<HTMLElement | null>(null),
    openingDialog = useRef(false);
  const moderated = !!(
    s.metadata.provenance?.conversationId || s.metadata.reviewId
  );
  const changed =
    s.status === "ready" &&
    processingChanged(s.metadata.processing, baseProcessing);
  const warnings = !!(
    s.error_code ||
    s.metadata.unrecognizedPages ||
    s.metadata.processingWarnings?.length ||
    changed
  );
  function open(view: "details" | "advanced") {
    opener.current = trigger.current;
    openingDialog.current = true;
    setSection("metadata");
    setDialog(view);
  }
  function canLeave() {
    return (
      !editorState.busy &&
      (!editorState.dirty ||
        window.confirm("Discard unsaved metadata changes?"))
    );
  }
  function close() {
    if (canLeave()) {
      setDialog(null);
      setEditorState({ dirty: false, busy: false });
    }
  }
  const errorHelp = s.error_code?.startsWith("FIRECRAWL_AUTHENTICATION")
    ? "Check the selected workspace Firecrawl key."
    : s.error_code === "FIRECRAWL_CREDITS_REQUIRED"
      ? "Add credits to your Firecrawl account."
      : s.error_code === "WEBSITE_REDIRECT_BLOCKED"
        ? "Use the final website URL and approve its exact host."
        : s.error_code === "WEBSITE_REDIRECT_LIMIT"
          ? "Use a direct URL without redirect loops."
          : s.error_code === "WEBSITE_PATH_BLOCKED"
            ? "Check the configured allowed and blocked paths."
            : s.error_code === "EMPTY_DOCUMENT"
              ? "Try Firecrawl for JavaScript-rendered pages."
              : "";
  return (
    <tr className="knowledge-source-row">
      {canManage && (
        <td className="knowledge-source-select">
          <input
            type="checkbox"
            aria-label={`Select source ${s.title}`}
            checked={selected}
            disabled={selectionDisabled}
            onChange={(e) => onSelected(e.target.checked)}
          />
        </td>
      )}
      <td className="knowledge-source-name">
        <div className="knowledge-source-identity">
          <button
            type="button"
            className="knowledge-source-title"
            title={s.title}
            onClick={(e) => {
              opener.current = e.currentTarget;
              setDialog("details");
            }}
          >
            {s.title}
          </button>
          {s.kind === "qa" && (
            <span
              className="knowledge-origin-badge"
              title={moderated ? "Moderated from chat history" : "Added here"}
            >
              {moderated ? "From history" : "Added here"}
            </span>
          )}
          {s.metadata.goldenAnswer && (
            <span className="knowledge-golden-badge">Golden</span>
          )}
        </div>
      </td>
      <td className="knowledge-source-state">
        <span className={`source-status ${s.status}`}>{s.status}</span>
        {warnings && (
          <button
            type="button"
            className="knowledge-source-warning"
            aria-label={`Review warnings for ${s.title}`}
            title="Source needs review"
            onClick={(e) => {
              opener.current = e.currentTarget;
              setDialog("details");
            }}
          >
            <AlertTriangle size={14} />
          </button>
        )}
      </td>
      <td className="knowledge-source-chunks">{s.chunk_count}</td>
      <td className="knowledge-source-actions">
        <Menu.Root modal={false}>
          <Menu.Trigger asChild>
            <button
              ref={trigger}
              type="button"
              className="button secondary knowledge-more"
              aria-label={`More actions for ${s.title}`}
              title="More actions"
            >
              <Ellipsis size={18} />
            </button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content
              className="knowledge-row-menu"
              align="end"
              sideOffset={6}
              collisionPadding={12}
              onCloseAutoFocus={(e) => {
                if (openingDialog.current) {
                  e.preventDefault();
                  openingDialog.current = false;
                }
              }}
            >
              <Menu.Label className="knowledge-row-menu-label">
                Source actions
              </Menu.Label>
              <Menu.Item
                className="knowledge-row-menu-item"
                onSelect={() => open("details")}
              >
                <Eye size={15} />
                View details
              </Menu.Item>
              {canManage && s.kind === "qa" && (
                <Menu.Item
                  className="knowledge-row-menu-item"
                  disabled={busy}
                  onSelect={onEdit}
                >
                  <Pencil size={15} />
                  Edit Q&A
                </Menu.Item>
              )}
              {canManage && (
                <Menu.Item
                  className="knowledge-row-menu-item"
                  onSelect={() => open("advanced")}
                >
                  <Settings2 size={15} />
                  Advanced settings
                </Menu.Item>
              )}
              <Menu.Separator className="knowledge-row-menu-separator" />
              <Menu.Item
                className="knowledge-row-menu-item"
                disabled={busy || !s.chunk_count}
                onSelect={onInspect}
              >
                <Layers size={15} />
                Inspect chunks
              </Menu.Item>
              <Menu.Item
                className="knowledge-row-menu-item"
                disabled={busy || s.status !== "ready"}
                onSelect={onExtraction}
              >
                <FileSearch size={15} />
                Extraction preview
              </Menu.Item>
              <Menu.Item className="knowledge-row-menu-item" onSelect={onUsage}>
                <Activity size={15} />
                Usage &amp; traces
              </Menu.Item>
              {canManage && (
                <>
                  <Menu.Separator className="knowledge-row-menu-separator" />
                  <Menu.Item
                    className="knowledge-row-menu-item"
                    disabled={
                      busy || s.status === "queued" || s.status === "processing"
                    }
                    onSelect={onReingest}
                  >
                    <RefreshCw size={15} />
                    Reingest
                  </Menu.Item>
                  <Menu.Item
                    className="knowledge-row-menu-item danger"
                    disabled={busy}
                    onSelect={onRemove}
                  >
                    <Trash2 size={15} />
                    Remove
                  </Menu.Item>
                </>
              )}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        <Dialog.Root
          open={dialog !== null}
          onOpenChange={(v) => {
            if (!v) close();
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="dialog-overlay" />
            <Dialog.Content
              className="dialog-content knowledge-source-dialog"
              onCloseAutoFocus={(e) => {
                e.preventDefault();
                opener.current?.focus();
              }}
            >
              <Dialog.Title>
                {dialog === "advanced" ? "Advanced settings" : "Source details"}
              </Dialog.Title>
              <Dialog.Description className="knowledge-dialog-source-name">
                {s.title}
              </Dialog.Description>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="dialog-close"
                  aria-label="Close source dialog"
                  disabled={editorState.busy}
                >
                  <X size={18} />
                </button>
              </Dialog.Close>
              {dialog === "advanced" && canManage ? (
                <>
                  <div
                    className="knowledge-advanced-tabs"
                    role="group"
                    aria-label="Advanced settings sections"
                  >
                    <Button
                      className={section === "metadata" ? "" : "secondary"}
                      aria-pressed={section === "metadata"}
                      onClick={() => {
                        if (section !== "metadata" && canLeave()) {
                          setEditorState({ dirty: false, busy: false });
                          setSection("metadata");
                        }
                      }}
                    >
                      Tags &amp; metadata
                    </Button>
                    <Button
                      className={section === "ai" ? "" : "secondary"}
                      aria-pressed={section === "ai"}
                      onClick={() => {
                        if (section !== "ai" && canLeave()) {
                          setEditorState({ dirty: false, busy: false });
                          setSection("ai");
                        }
                      }}
                    >
                      AI metadata tagging
                    </Button>
                  </div>
                  {section === "metadata" ? (
                    <SourceMetadataEditor
                      expanded
                      path={path}
                      source={s}
                      onStateChange={setEditorState}
                      onSaved={onMetadataSaved}
                    />
                  ) : (
                    <section aria-label="AI metadata tagging">
                      <h3>AI metadata tagging</h3>
                      <p className="muted">
                        Choose a model to suggest tags, then review the
                        suggestions before applying them.
                      </p>
                      <TaggingRequest
                        path={path}
                        sourceIds={[s.id]}
                        models={models}
                        onQueued={onTaggingQueued}
                      />
                      {taggingJobs.map((job) => (
                        <SuggestionReview
                          expanded
                          key={job.id + ":" + job.status}
                          path={path}
                          job={job}
                          onSaved={onTaggingQueued}
                        />
                      ))}
                    </section>
                  )}
                </>
              ) : (
                <div className="knowledge-source-details">
                  <dl>
                    <div>
                      <dt>Type</dt>
                      <dd>{s.kind}</dd>
                    </div>
                    <div>
                      <dt>Revision</dt>
                      <dd>{s.revision}</dd>
                    </div>
                    <div>
                      <dt>Status</dt>
                      <dd>{s.status}</dd>
                    </div>
                    <div>
                      <dt>Chunks</dt>
                      <dd>{s.chunk_count}</dd>
                    </div>
                    {s.kind === "qa" && (
                      <div>
                        <dt>Origin</dt>
                        <dd>
                          {moderated
                            ? "Moderated from chat history"
                            : "Added here"}
                          {s.metadata.goldenAnswer ? " · Golden answer" : ""}
                        </dd>
                      </div>
                    )}
                    {s.filename && (
                      <div>
                        <dt>File</dt>
                        <dd>{s.filename}</dd>
                      </div>
                    )}
                    {s.source_url && (
                      <div>
                        <dt>Source URL</dt>
                        <dd>{s.source_url}</dd>
                      </div>
                    )}
                    {s.metadata.tags?.length ? (
                      <div>
                        <dt>Tags</dt>
                        <dd>{s.metadata.tags.join(", ")}</dd>
                      </div>
                    ) : null}
                    {Object.entries(s.metadata.attributes ?? {}).map(
                      ([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>{value}</dd>
                        </div>
                      ),
                    )}
                  </dl>
                  {s.kind === "qa" && (
                    <section aria-label="Question and answer">
                      <h3>Question</h3>
                      <p>{s.metadata.question ?? s.title}</p>
                      <h3>Answer</h3>
                      <p className="knowledge-full-answer">
                        {s.metadata.answer ?? "No answer text available"}
                      </p>
                      {s.metadata.provenance?.conversationId && (
                        <WorkspaceRecordLink
                          workspaceId={workspaceId}
                          view="Conversations"
                          record={{
                            conversation: s.metadata.provenance.conversationId,
                          }}
                        >
                          View source conversation
                        </WorkspaceRecordLink>
                      )}
                    </section>
                  )}
                  {warnings && (
                    <section
                      className="knowledge-source-notices"
                      aria-label="Source warnings"
                    >
                      <h3>Needs review</h3>
                      {s.error_code && (
                        <p className="error">
                          {s.error_code}
                          {errorHelp ? `: ${errorHelp}` : ""}
                        </p>
                      )}
                      {!!s.metadata.unrecognizedPages && (
                        <p>
                          {s.metadata.unrecognizedPages} pages may contain
                          unrecognized scanned content. Enable OCR and reingest
                          if needed.
                        </p>
                      )}
                      {s.metadata.processingWarnings?.map((text, i) => (
                        <p key={i}>{text}</p>
                      ))}
                      {changed && <p>Processing changed · Reingest to apply</p>}
                    </section>
                  )}
                  {s.metadata.aiExtractionProgress && (
                    <p>
                      AI page {s.metadata.aiExtractionProgress.page} ·{" "}
                      {s.metadata.aiExtractionProgress.extractedPages}/
                      {s.metadata.aiExtractionProgress.maxPages} page allowance
                    </p>
                  )}
                  {!!s.metadata.ocrPages && (
                    <p>
                      OCR recognized {s.metadata.ocrPages} pages · review
                      accuracy
                    </p>
                  )}
                  {s.metadata.crawlPageCount !== undefined && (
                    <p>{s.metadata.crawlPageCount} website pages indexed</p>
                  )}
                  {s.metadata.connectorId && (
                    <p className="muted">
                      Managed source: {s.metadata.externalKey}. Sync can restore
                      a deleted file while the connector is active.
                    </p>
                  )}
                </div>
              )}
              <div className="knowledge-source-dialog-footer">
                <Button
                  className="secondary"
                  disabled={editorState.busy}
                  onClick={close}
                >
                  Done
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </td>
    </tr>
  );
}
