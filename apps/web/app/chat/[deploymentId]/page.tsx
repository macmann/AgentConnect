import { HostedChat } from "../../../components/hosted-chat";
export default async function Page({
  params,
}: {
  params: Promise<{ deploymentId: string }>;
}) {
  const { deploymentId } = await params;
  return <HostedChat deploymentId={deploymentId} />;
}
