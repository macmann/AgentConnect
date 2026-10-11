"use client";
import { useEffect, useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
const key = "agent-connex-theme";
const event = "agent-connex-theme-change";
function subscribe(listener: () => void) {
  window.addEventListener(event, listener);
  return () => window.removeEventListener(event, listener);
}
function apply(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  window.dispatchEvent(new Event(event));
}
export function ThemeController() {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    function sync() {
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(key);
      } catch {
        /* Browser storage may be disabled. */
      }
      apply(
        saved === "light" || saved === "dark"
          ? saved
          : media.matches
            ? "dark"
            : "light",
      );
    }
    sync();
    media.addEventListener("change", sync);
    window.addEventListener("storage", sync);
    return () => {
      media.removeEventListener("change", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return null;
}
export function ThemeSwitcher() {
  const theme = useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset.theme ?? "light",
    () => "light",
  );
  const target = theme === "dark" ? "light" : "dark";
  return (
    <button
      className="theme-switcher"
      aria-label={`Switch to ${target} theme`}
      title={`Switch to ${target} theme`}
      onClick={() => {
        try {
          localStorage.setItem(key, target);
        } catch {
          /* Keep the current-session preference. */
        }
        apply(target);
      }}
    >
      {target === "dark" ? (
        <Moon size={17} aria-hidden="true" />
      ) : (
        <Sun size={17} aria-hidden="true" />
      )}
      <span>{target === "dark" ? "Dark" : "Light"}</span>
    </button>
  );
}
