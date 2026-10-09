import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "AgentConnect · Workspace",
  description: "Build, orchestrate, and govern enterprise AI agents.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
