"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";

import { Icon } from "@/components/ui/Icon";

const focusableSelector = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]"
].join(",");

function getFocusableElements(drawer: HTMLElement): HTMLElement[] {
  return Array.from(drawer.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => {
      if (
        element.tabIndex < 0 ||
        element.closest("[hidden], [inert], [aria-hidden='true']")
      ) {
        return false;
      }
      const style = window.getComputedStyle(element);
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        element.getClientRects().length > 0;
    }
  );
}

function focusFirstElement(drawer: HTMLElement): void {
  (getFocusableElements(drawer)[0] ?? drawer).focus();
}

function trapFocus(event: KeyboardEvent, drawer: HTMLElement): void {
  if (event.key !== "Tab") return;

  const elements = getFocusableElements(drawer);
  if (elements.length === 0) {
    event.preventDefault();
    drawer.focus();
    return;
  }

  const first = elements[0];
  const last = elements[elements.length - 1];
  const active = document.activeElement;
  const focusIsOutside = active === drawer || !active || !drawer.contains(active);

  if (event.shiftKey && (active === first || focusIsOutside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || focusIsOutside)) {
    event.preventDefault();
    first.focus();
  }
}

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
  const drawerRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const drawer = drawerRef.current;
    if (!drawer) return;

    const previousFocus = document.activeElement;
    previousFocusRef.current =
      previousFocus instanceof HTMLElement ? previousFocus : null;
    (closeRef.current ?? drawer).focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      trapFocus(event, drawer);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && drawer.contains(event.target)) return;
      focusFirstElement(drawer);
    };
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn);
      const previous = previousFocusRef.current;
      previousFocusRef.current = null;
      if (previous?.isConnected) {
        try {
          previous.focus();
        } catch {
          // The original control may have become unavailable while closing.
        }
      }
    };
  }, [open]);

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
        aria-labelledby={titleId}
        aria-modal={open ? true : undefined}
        className={`detail-drawer ${open ? "detail-drawer--open" : ""}`}
        inert={!open}
        ref={drawerRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="detail-drawer__header">
          <div>
            <span className="eyebrow">详细信息</span>
            <h2 id={titleId}>{title}</h2>
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
