import { Suspense } from "react";

import { LoadingState, PageHeader } from "@/components/ui/PageElements";
import { ProjectsView } from "@/views/ProjectsView";

export const metadata = { title: "项目" };

export default function ProjectsPage() {
  return (
    <Suspense fallback={<><PageHeader description="统一 Windows 与 macOS 上的项目归属" title="项目" /><LoadingState rows={6} /></>}>
      <ProjectsView />
    </Suspense>
  );
}
