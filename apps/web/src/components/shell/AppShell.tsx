import type { ReactNode } from "react";

import { DrawerProvider } from "./DrawerContext";
import { SideNav } from "./SideNav";
import { TopToolbar } from "./TopToolbar";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <DrawerProvider>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <div className="app-shell">
        <SideNav />
        <div className="app-shell__workspace">
          <TopToolbar />
          <main className="main-content" id="main-content" tabIndex={-1}>
            {children}
          </main>
        </div>
      </div>
    </DrawerProvider>
  );
}
