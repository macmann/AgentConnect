"use client";
import { useId, useRef, useState, type ReactNode } from "react";

/** Help remains available to pointer, keyboard and touch users without expanding the form. */
export function HelpTooltip({
  children,
  label = "More information",
  id,
}: {
  children: ReactNode;
  label?: string;
  id?: string;
}) {
  const generated = useId();
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const helpId = id ?? generated;
  const trigger = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState({ left: 16, top: 16 });
  function place() {
    setDismissed(false);
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds) return;
    const width = Math.min(340, window.innerWidth - 32);
    setPosition({
      left: Math.max(16, Math.min(bounds.left, window.innerWidth - width - 16)),
      top: Math.max(16, Math.min(bounds.bottom + 8, window.innerHeight - 220)),
    });
  }
  return (
    <span
      className="help-tooltip"
      data-open={open || undefined}
      data-dismissed={dismissed || undefined}
      onMouseEnter={place}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        ref={trigger}
        onFocus={place}
        type="button"
        className="help-tooltip-trigger"
        aria-label={label}
        aria-describedby={helpId}
        onClick={() => {
          setDismissed(open);
          setOpen(!open);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
            setDismissed(true);
          }
        }}
      >
        ⓘ
      </button>
      <span
        role="tooltip"
        id={helpId}
        className="help-tooltip-content"
        style={position}
      >
        {children}
      </span>
    </span>
  );
}
