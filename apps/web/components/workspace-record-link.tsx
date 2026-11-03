"use client";
import { useEffect, useState, type ReactNode } from "react";
export function WorkspaceRecordLink({
  workspaceId,
  view,
  record,
  children,
}: {
  workspaceId: string;
  view: string;
  record: Record<string, string>;
  children: ReactNode;
}) {
  const values = JSON.stringify(record),
    [href, setHref] = useState(
      `#${new URLSearchParams({ view, workspace: workspaceId, ...record })}`,
    );
  useEffect(() => {
    const p = new URLSearchParams(location.hash.slice(1));
    for (const key of [
      "agent",
      "stage",
      "section",
      "conversation",
      "historyAgent",
      "knowledgeBase",
      "knowledgeView",
    ])
      p.delete(key);
    p.set("view", view);
    p.set("workspace", workspaceId);
    for (const [key, value] of Object.entries(
      JSON.parse(values) as Record<string, string>,
    ))
      p.set(key, value);
    setHref(`#${p}`);
  }, [workspaceId, view, values]);
  return (
    <a className="text-button" href={href}>
      {children}
    </a>
  );
}
