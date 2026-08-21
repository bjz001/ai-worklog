import { Suspense } from "react";

import { LoadingState, PageHeader } from "@/components/ui/PageElements";
import { AgentRunsView } from "@/views/AgentRunsView";

export const metadata = { title: "Agent 轨迹" };

export default function AgentRunsPage() {
  return (
    <Suspense fallback={<><PageHeader description="搜索四类 Agent 的完整事件轨迹" title="Agent 轨迹" /><LoadingState rows={7} /></>}>
      <AgentRunsView />
    </Suspense>
  );
}
