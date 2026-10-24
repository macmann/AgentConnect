import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Agent Connex · Workspace",
  icons: {
    icon: {
      url: "/agent-connex-icon-light.svg",
      type: "image/svg+xml",
      sizes: "any",
    },
  },
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
      <body>{children}</body>
    </html>
  );
}
