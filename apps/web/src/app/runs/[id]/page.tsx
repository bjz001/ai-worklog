import { Suspense } from "react";

import { AgentRunExplorer } from "@/components/runs/AgentRunExplorer";
import { LoadingState } from "@/components/ui/PageElements";

export const metadata = { title: "Agent 调用透明视图" };

export default async function AgentRunDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <Suspense fallback={<LoadingState rows={9} />}>
      <AgentRunExplorer runId={id} />
    </Suspense>
  );
}
