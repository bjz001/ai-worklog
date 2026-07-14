"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState
} from "react";

import { DetailDrawer } from "./DetailDrawer";

type DrawerPayload = {
  title: string;
  subtitle?: string;
  content: ReactNode;
};

type DrawerContextValue = {
  closeDrawer: () => void;
  openDrawer: (payload: DrawerPayload) => void;
};

const DrawerContext = createContext<DrawerContextValue | null>(null);

export function DrawerProvider({ children }: { children: ReactNode }) {
  const [drawer, setDrawer] = useState<DrawerPayload | null>(null);
  const closeDrawer = useCallback(() => setDrawer(null), []);
  const openDrawer = useCallback((payload: DrawerPayload) => setDrawer(payload), []);
  const value = useMemo(
    () => ({ closeDrawer, openDrawer }),
    [closeDrawer, openDrawer]
  );

  return (
    <DrawerContext.Provider value={value}>
      {children}
      <DetailDrawer
        onClose={closeDrawer}
        open={drawer !== null}
        subtitle={drawer?.subtitle}
        title={drawer?.title ?? "详情"}
      >
        {drawer?.content}
      </DetailDrawer>
    </DrawerContext.Provider>
  );
}

export function useDetailDrawer(): DrawerContextValue {
  const context = useContext(DrawerContext);
  if (!context) {
    throw new Error("useDetailDrawer must be used inside DrawerProvider");
  }
  return context;
}
