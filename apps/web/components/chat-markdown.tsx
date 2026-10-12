"use client";
import { useDeferredValue } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
/** Markdown is data: raw HTML is skipped and the renderer's safe URL policy stays enabled. */
export function ChatMarkdown({ content }: { content: string }) {
  const text = useDeferredValue(content);
  return (
    <div className="chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>,
          table: ({ children }) => (
            <div
              className="chat-markdown-table"
              tabIndex={0}
              role="region"
              aria-label="Response table"
            >
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
