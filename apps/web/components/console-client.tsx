"use client";

import dynamic from "next/dynamic";

// "use client" still permits server rendering. Keep the browser dashboard and
// its third-party hook providers out of both prerendering and request-time SSR.
const BrowserConsole = dynamic(
  () => import("./console").then((module) => module.Console),
  {
    ssr: false,
    loading: () => <p role="status">Loading workspace…</p>,
  },
);

export function ConsoleClient() {
  return <BrowserConsole />;
}
