"use client";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
const key = "agent-connex-theme";
const event = "agent-connex-theme-change";
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
  // Keep the server and initial hydration render identical. The head script
  // applies the page theme before paint; read it only after mounting.
  const [theme, setTheme] = useState<"light" | "dark">("light");
  useEffect(() => {
    function sync() {
      setTheme(
        document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      );
    }
    window.addEventListener(event, sync);
    sync();
    return () => window.removeEventListener(event, sync);
  }, []);
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
