import { ConsoleClient } from "../components/console-client";

// The authenticated dashboard has no build-time content to prerender.
export const dynamic = "force-dynamic";

export default function Page() {
  return <ConsoleClient />;
}
