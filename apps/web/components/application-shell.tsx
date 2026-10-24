"use client";

import { ThemeController, ThemeSwitcher } from "./theme-switcher";

// Only normal application routes mount interactive theme controls. Framework
// fallback documents must not depend on application components or providers.
export function ApplicationShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <ThemeController />
      <div className="global-theme-control">
        <ThemeSwitcher />
      </div>
      {children}
    </>
  );
}
