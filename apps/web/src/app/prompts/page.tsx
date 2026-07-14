import { Suspense } from "react";

import { LoadingState, PageHeader } from "@/components/ui/PageElements";
import { PromptsView } from "@/views/PromptsView";

export const metadata = { title: "Prompt 库" };

export default function PromptsPage() {
  return (
    <Suspense fallback={<><PageHeader description="搜索跨设备的脱敏 Prompt" title="Prompt 库" /><LoadingState rows={7} /></>}>
      <PromptsView />
    </Suspense>
  );
}
