import { HostedChat } from "../../../components/hosted-chat";
import { ApplicationShell } from "../../../components/application-shell";
export default async function Page({
  params,
}: {
  params: Promise<{ deploymentId: string }>;
}) {
  const { deploymentId } = await params;
  return (
    <ApplicationShell>
      <HostedChat deploymentId={deploymentId} />
    </ApplicationShell>
  );
}
