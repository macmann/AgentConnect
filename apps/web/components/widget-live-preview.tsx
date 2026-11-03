"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiBase } from "./agent-client";
import { Button } from "./button";
import {
  widgetPreviewDocument,
  type WidgetPresentation,
} from "./widget-preview-document";
export function WidgetLivePreview({
  deploymentId,
  presentation,
}: {
  deploymentId: string;
  presentation: WidgetPresentation;
}) {
  const [open, setOpen] = useState(true),
    [origin, setOrigin] = useState(""),
    [available, setAvailable] = useState(480),
    [state, setState] = useState<"loading" | "ready" | "error">("loading"),
    [retry, setRetry] = useState(0);
  const container = useRef<HTMLDivElement>(null),
    frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    setOrigin(window.location.origin);
    const node = container.current;
    if (!node) return;
    const observer = new ResizeObserver(
      ([entry]) => entry && setAvailable(entry.contentRect.width),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const proposed = useMemo(
    () =>
      origin
        ? widgetPreviewDocument(
            apiBase,
            deploymentId,
            presentation,
            open,
            origin,
          )
        : "",
    [deploymentId, presentation, open, origin],
  );
  const [source, setSource] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSource(proposed), 150);
    return () => clearTimeout(timer);
  }, [proposed]);
  useEffect(() => {
    setState("loading");
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "agentconnect-widget-preview-ready")
        setState("ready");
      if (event.data?.type === "agentconnect-widget-preview-error")
        setState("error");
    };
    window.addEventListener("message", receive);
    const timeout = setTimeout(
      () => setState((s) => (s === "loading" ? "error" : s)),
      12000,
    );
    return () => {
      window.removeEventListener("message", receive);
      clearTimeout(timeout);
    };
  }, [source, retry]);
  const width = presentation.widget.width + 40,
    height = presentation.widget.height + 90,
    scale = Math.min(1, available / width);
  return (
    <aside className="widget-live-preview" aria-label="Widget live preview">
      <div className="widget-preview-heading">
        <div>
          <h3>Live preview</h3>
          <p>Unsaved changes · uses the real widget</p>
        </div>
        <div role="group" aria-label="Preview state">
          <Button
            type="button"
            className={open ? "" : "secondary"}
            aria-pressed={open}
            onClick={() => setOpen(true)}
          >
            Chat
          </Button>
          <Button
            type="button"
            className={open ? "secondary" : ""}
            aria-pressed={!open}
            onClick={() => setOpen(false)}
          >
            Launcher
          </Button>
        </div>
      </div>
      <div ref={container} className="widget-preview-canvas">
        <div
          className="widget-preview-frame-space"
          style={{ height: height * scale }}
        >
          {source && (
            <iframe
              key={retry}
              ref={frame}
              title="Live website widget preview"
              sandbox="allow-scripts allow-forms"
              srcDoc={source}
              style={{
                width,
                height,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
            />
          )}
        </div>
      </div>
      <div className="widget-preview-caption">
        <span>
          {presentation.widget.width} × {presentation.widget.height}px
          {scale < 1 ? " · scaled to fit" : ""}
        </span>
        <span role="status">
          {state === "loading"
            ? "Loading preview…"
            : state === "ready"
              ? "Example conversation only"
              : "Preview unavailable. Check API access."}
        </span>
        {state === "error" && (
          <Button
            type="button"
            className="secondary"
            onClick={() => setRetry((v) => v + 1)}
          >
            Retry preview
          </Button>
        )}
      </div>
    </aside>
  );
}
