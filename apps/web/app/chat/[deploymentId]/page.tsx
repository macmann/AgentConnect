import { HostedChat } from "../../../components/hosted-chat";
import type { Metadata } from "next";
export const metadata: Metadata = {
  title: "Chat",
  description: "Chat with your assistant.",
  icons: { icon: [], apple: [], shortcut: [] },
};
export default async function Page({
  params,
}: {
  params: Promise<{ deploymentId: string }>;
}) {
  const { deploymentId } = await params;
  return <HostedChat deploymentId={deploymentId} />;
}
