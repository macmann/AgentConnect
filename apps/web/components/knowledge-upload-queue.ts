export const MAX_UPLOAD_FILES = 100;
export const MAX_UPLOAD_BYTES = 10_000_000;
export const uploadExtensions = [
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "csv",
  "txt",
  "md",
  "markdown",
  "html",
  "htm",
  "json",
  "png",
  "jpg",
  "jpeg",
  "webp",
];
export type UploadRow = {
  id: string;
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  name: string;
  size: number;
  status: "waiting" | "uploading" | "uploaded" | "failed" | "cancelled";
  progress: number;
  error?: string;
  invalid?: boolean;
  sourceId?: string;
};
export type UploadSnapshot = {
  rows: UploadRow[];
  paused: boolean;
  concurrency: number;
};
export type UploadTransport = (
  row: UploadRow,
  file: File,
  progress: (n: number) => void,
  signal: AbortSignal,
) => Promise<{ id: string }>;
export function uploadFile(apiBase: string): UploadTransport {
  return (row, file, progress, signal) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(
        "POST",
        `${apiBase}/knowledge-bases/${row.knowledgeBaseId}/upload`,
      );
      xhr.withCredentials = true;
      xhr.timeout = 300000;
      xhr.setRequestHeader("Idempotency-Key", row.id);
      const abort = () => xhr.abort(),
        clean = () => signal.removeEventListener("abort", abort);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          progress(Math.min(100, Math.round((e.loaded / e.total) * 100)));
      };
      xhr.onload = () => {
        clean();
        let data: { id?: string; error?: string };
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          reject(
            new Error("Unexpected response. Retry uses the same upload key."),
          );
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300 && data.id)
          resolve({ id: data.id });
        else
          reject(
            new Error(
              data.error ??
                `Upload failed (HTTP ${xhr.status}). Retry when ready.`,
            ),
          );
      };
      xhr.onerror = () => {
        clean();
        reject(new Error("Connection lost. Retry uses the same upload key."));
      };
      xhr.ontimeout = () => {
        clean();
        reject(new Error("Upload timed out. Retry uses the same upload key."));
      };
      xhr.onabort = () => {
        clean();
        reject(
          new Error(
            "Upload cancelled. Check Sources if the server already received it.",
          ),
        );
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        clean();
        reject(new Error("Upload cancelled"));
        return;
      }
      const body = new FormData();
      body.append("file", file);
      xhr.send(body);
    });
}
/** One mounted Knowledge page owns this bounded browser queue; no file data is persisted. */
export class KnowledgeUploadQueue {
  private snapshot: UploadSnapshot = {
    rows: [],
    paused: false,
    concurrency: 2,
  };
  private listeners = new Set<() => void>();
  private files = new Map<string, File>();
  private active = new Map<string, AbortController>();
  private disposed = false;
  constructor(
    private transport: UploadTransport,
    private onUploaded: () => void = () => {},
  ) {}
  activate() {
    this.disposed = false;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private publish(next: UploadSnapshot) {
    this.snapshot = next;
    for (const fn of this.listeners) fn();
  }
  private patch(id: string, change: Partial<UploadRow>) {
    this.publish({
      ...this.snapshot,
      rows: this.snapshot.rows.map((r) =>
        r.id === id ? { ...r, ...change } : r,
      ),
    });
  }
  add(files: File[], base: { id: string; name: string }) {
    if (this.disposed) throw new Error("Upload queue is closed");
    if (!files.length) throw new Error("Select at least one document");
    if (this.snapshot.rows.length + files.length > MAX_UPLOAD_FILES)
      throw new Error(
        "The queue holds up to 100 files. Clear finished files before adding more.",
      );
    const rows = files.map((file) => {
      const id = crypto.randomUUID(),
        ext = file.name.split(".").pop()?.toLowerCase();
      const error = !file.size
        ? "File is empty"
        : file.size > MAX_UPLOAD_BYTES
          ? "File exceeds 10 MB"
          : !uploadExtensions.includes(ext ?? "")
            ? "Unsupported file type"
            : undefined;
      this.files.set(id, file);
      return {
        id,
        knowledgeBaseId: base.id,
        knowledgeBaseName: base.name,
        name: file.name,
        size: file.size,
        status: error ? "failed" : "waiting",
        progress: 0,
        ...(error ? { error, invalid: true } : {}),
      } as UploadRow;
    });
    this.publish({ ...this.snapshot, rows: [...this.snapshot.rows, ...rows] });
    this.pump();
  }
  pause(paused: boolean) {
    this.publish({ ...this.snapshot, paused });
    this.pump();
  }
  concurrency(n: number) {
    if (![1, 2, 3].includes(n)) return;
    this.publish({ ...this.snapshot, concurrency: n });
    this.pump();
  }
  cancel(id: string) {
    const row = this.snapshot.rows.find((r) => r.id === id);
    if (!row || !["waiting", "uploading"].includes(row.status)) return;
    this.patch(id, {
      status: "cancelled",
      error:
        row.status === "uploading"
          ? "Cancelled; check Sources if already received."
          : "Cancelled before upload",
    });
    this.active.get(id)?.abort();
  }
  cancelPending() {
    for (const row of this.snapshot.rows) this.cancel(row.id);
  }
  retry(id: string) {
    const row = this.snapshot.rows.find((r) => r.id === id);
    if (
      !row ||
      row.invalid ||
      !["failed", "cancelled"].includes(row.status) ||
      this.active.has(id) ||
      !this.files.has(id)
    )
      return;
    this.patch(id, { status: "waiting", error: undefined, progress: 0 });
    this.pump();
  }
  remove(id: string) {
    if (this.active.has(id)) return;
    this.files.delete(id);
    this.publish({
      ...this.snapshot,
      rows: this.snapshot.rows.filter((r) => r.id !== id),
    });
  }
  clearFinished() {
    for (const row of this.snapshot.rows)
      if (
        !["waiting", "uploading"].includes(row.status) &&
        !this.active.has(row.id)
      )
        this.remove(row.id);
  }
  hasPending = () =>
    this.snapshot.rows.some(
      (r) => r.status === "waiting" || r.status === "uploading",
    );
  dispose() {
    this.disposed = true;
    for (const c of this.active.values()) c.abort();
    this.files.clear();
    this.listeners.clear();
  }
  private pump() {
    while (
      !this.disposed &&
      !this.snapshot.paused &&
      this.active.size < this.snapshot.concurrency
    ) {
      const row = this.snapshot.rows.find(
        (r) => r.status === "waiting" && !this.active.has(r.id),
      );
      if (!row) return;
      const file = this.files.get(row.id);
      if (!file) return;
      const controller = new AbortController();
      this.active.set(row.id, controller);
      this.patch(row.id, { status: "uploading" });
      void Promise.resolve()
        .then(() => {
          if (controller.signal.aborted) throw new Error("Upload cancelled");
          return this.transport(
            row,
            file,
            (n) => {
              if (!this.disposed && !controller.signal.aborted)
                this.patch(row.id, { progress: n });
            },
            controller.signal,
          );
        })
        .then((result) => {
          if (this.disposed || controller.signal.aborted) return;
          this.patch(row.id, {
            status: "uploaded",
            progress: 100,
            sourceId: result.id,
            error: undefined,
          });
          this.files.delete(row.id);
          this.onUploaded();
        })
        .catch((error) => {
          if (this.disposed || controller.signal.aborted) return;
          this.patch(row.id, {
            status: "failed",
            error: error instanceof Error ? error.message : "Upload failed",
          });
        })
        .finally(() => {
          this.active.delete(row.id);
          if (!this.disposed) {
            this.publish({ ...this.snapshot });
            this.pump();
          }
        });
    }
  }
}
