"use client";

import type { ReactNode } from "react";
import { HelpTooltip } from "./help-tooltip";

/** Short context stays visible; supporting detail is available on focus/tap. */
export function SettingsHint({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-hint">
      <span>{label}</span>
      <HelpTooltip label={`About ${label.toLowerCase()}`}>
        {children}
      </HelpTooltip>
    </div>
  );
}

/** Multi-step help and links belong in a disclosure, rather than a tooltip. */
export function SetupGuide({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="settings-guide">
      <summary>{title}</summary>
      <div className="settings-guide-body">{children}</div>
    </details>
  );
}
