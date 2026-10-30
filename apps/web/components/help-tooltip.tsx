"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Portaled help avoids clipping by scroll panels, sticky bars and the canvas. */
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
  const helpId = id ?? generated;
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState({
    left: 16,
    top: 16,
    maxHeight: 220,
  });
  const trigger = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function cancelClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }
  function closeSoon() {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  }
  function show() {
    cancelClose();
    const container =
      trigger.current?.closest<HTMLElement>('[role="dialog"]') ?? document.body;
    setHost(container);
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds) return;
    const width = Math.min(340, window.innerWidth - 32);
    const left = Math.max(
      16,
      Math.min(bounds.left, window.innerWidth - width - 16),
    );
    const top = Math.max(
      16,
      Math.min(bounds.bottom + 8, window.innerHeight - 220),
    );
    // A transformed modal establishes a containing block even for fixed children.
    const style = getComputedStyle(container);
    const rect =
      style.transform !== "none" ? container.getBoundingClientRect() : null;
    setPosition({
      left: left - (rect?.left ?? 0),
      top: top - (rect?.top ?? 0),
      maxHeight: Math.min(300, window.innerHeight - top - 16),
    });
    setOpen(true);
  }
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    function close(event: Event) {
      if (
        event.type === "scroll" &&
        tip.current?.contains(event.target as Node)
      )
        return;
      setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    function outside(event: PointerEvent) {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !tip.current?.contains(event.target as Node)
      )
        setOpen(false);
    }
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  return (
    <span className="help-tooltip">
      <button
        ref={trigger}
        type="button"
        className="help-tooltip-trigger"
        aria-label={label}
        aria-describedby={helpId}
        onMouseEnter={show}
        onMouseLeave={closeSoon}
        onFocus={show}
        onBlur={() => setOpen(false)}
        onClick={show}
      >
        ⓘ
      </button>
      {host ? (
        createPortal(
          <span
            ref={tip}
            role="tooltip"
            id={helpId}
            hidden={!open}
            className="help-tooltip-content help-tooltip-portal"
            style={position}
            onMouseEnter={cancelClose}
            onMouseLeave={closeSoon}
          >
            {children}
          </span>,
          host,
        )
      ) : (
        <span role="tooltip" id={helpId} hidden>
          {children}
        </span>
      )}
    </span>
  );
}
