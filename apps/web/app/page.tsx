import { ConsoleClient } from "../components/console-client";
import { ApplicationShell } from "../components/application-shell";

// The authenticated dashboard has no build-time content to prerender.
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <ApplicationShell>
      <ConsoleClient />
    </ApplicationShell>
  );
}
