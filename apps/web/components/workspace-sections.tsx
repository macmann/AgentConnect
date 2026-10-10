"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export type WorkspaceSection = {
  id: string;
  label: string;
  description: string;
  count?: number;
};

// Keep section state in the existing hash route without replacing its workspace,
// agent or view parameters. Forms stay owned by their original page.
export function useWorkspaceSection(
  key: string,
  initial: string,
  allowed: string[],
) {
  const [section, setSection] = useState(initial);
  const signature = allowed.join("|");
  useEffect(() => {
    const read = () => {
      const value = new URLSearchParams(window.location.hash.slice(1)).get(key);
      setSection(
        value && signature.split("|").includes(value) ? value : initial,
      );
    };
    read();
    window.addEventListener("hashchange", read);
    window.addEventListener("popstate", read);
    return () => {
      window.removeEventListener("hashchange", read);
      window.removeEventListener("popstate", read);
    };
  }, [key, initial, signature]);
  const navigate = (value: string) => {
    if (!allowed.includes(value)) return;
    const params = new URLSearchParams(window.location.hash.slice(1));
    params.set(key, value);
    window.history.pushState(null, "", `#${params}`);
    setSection(value);
    window.dispatchEvent(new Event("workspace-section:navigated"));
  };
  return [section, navigate] as const;
}

export function WorkspaceSections({
  label,
  sections,
  value,
  onChange,
}: {
  label: string;
  sections: WorkspaceSection[];
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const active = sections.find((s) => s.id === value);
  return (
    <div className="workspace-section-navigation">
      <nav
        aria-label={`${label} navigation`}
        className="workspace-section-desktop"
      >
        {sections.map((s) => (
          <button
            type="button"
            key={s.id}
            aria-label={s.label}
            aria-current={s.id === value ? "page" : undefined}
            onClick={() => onChange(s.id)}
          >
            <span>{s.label}</span>
            {s.count !== undefined && (
              <span className="workspace-section-count">{s.count}</span>
            )}
          </button>
        ))}
      </nav>
      <label className="workspace-section-mobile" htmlFor={id}>
        {label}
        <select
          aria-label={label}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
              {s.count !== undefined ? ` (${s.count})` : ""}
            </option>
          ))}
        </select>
      </label>
      {active && (
        <p className="workspace-section-description">{active.description}</p>
      )}
    </div>
  );
}

export function useWorkspaceLeaveGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: Event) => {
      if (
        !window.confirm(
          "You have unsaved changes. Leave this page and discard them?",
        )
      )
        event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("agent-studio:before-leave", leave);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("agent-studio:before-leave", leave);
      window.removeEventListener("beforeunload", unload);
    };
  }, [dirty]);
}

// Keep focused fields visible above the save bar, including native validation
// that focuses a field near the viewport edge.
export function WorkspaceSaveBar({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reveal = (event: FocusEvent) => {
      const bar = ref.current;
      const field = event.target;
      if (
        !bar ||
        !(field instanceof HTMLElement) ||
        !field.matches("input, select, textarea")
      )
        return;
      const owner = bar.closest("form") ?? bar.closest(".studio-form");
      if (!owner?.contains(field)) return;
      const control = field.getBoundingClientRect();
      const actions = bar.getBoundingClientRect();
      if (control.bottom > actions.top - 16 && control.top < actions.bottom) {
        field.scrollIntoView({ block: "center", behavior: "instant" });
      }
    };
    document.addEventListener("focusin", reveal);
    return () => document.removeEventListener("focusin", reveal);
  }, []);
  return (
    <div ref={ref} className="workspace-save-bar">
      {children}
    </div>
  );
}
