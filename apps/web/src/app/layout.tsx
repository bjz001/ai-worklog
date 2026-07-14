import type { Metadata } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/shell/AppShell";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "AI 工作沉淀台",
    template: "%s · AI 工作沉淀台"
  },
  description: "跨设备整理 AI Prompt、工作总结与 Skill 沉淀"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
