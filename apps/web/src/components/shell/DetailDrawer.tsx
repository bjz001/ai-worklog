"use client";

import { type ReactNode, useEffect, useRef } from "react";

import { Icon } from "@/components/ui/Icon";

export function DetailDrawer({
  open,
  title,
  subtitle,
  onClose,
  children
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [onClose, open]);

  return (
    <>
      <button
        aria-hidden={!open}
        aria-label="关闭详情"
        className={`drawer-scrim ${open ? "drawer-scrim--open" : ""}`}
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <aside
        aria-hidden={!open}
        aria-labelledby="detail-drawer-title"
        className={`detail-drawer ${open ? "detail-drawer--open" : ""}`}
        inert={!open}
        role="dialog"
      >
        <header className="detail-drawer__header">
          <div>
            <span className="eyebrow">详细信息</span>
            <h2 id="detail-drawer-title">{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button
            aria-label="关闭详情"
            className="icon-button"
            onClick={onClose}
            ref={closeRef}
            type="button"
          >
            <Icon name="close" />
          </button>
        </header>
        <div className="detail-drawer__body">{children}</div>
      </aside>
    </>
  );
}
