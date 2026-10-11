import type { Metadata } from "next";
import "./globals.css";
import { ThemeController, ThemeSwitcher } from "../components/theme-switcher";
export const metadata: Metadata = {
  title: "Agent Connex · Workspace",
  icons: { icon: "/agent-connex-logo.svg" },
  description: "Build, orchestrate, and govern enterprise AI agents.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('agent-connex-theme');if(t!=='light'&&t!=='dark')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t;}catch{document.documentElement.dataset.theme='light';}`,
          }}
        />
      </head>
      <body>
        <ThemeController />
        <div className="global-theme-control">
          <ThemeSwitcher />
        </div>
        {children}
      </body>
    </html>
  );
}
