export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Private LAN HTTP pages may not expose the Clipboard API.
  }

  const previousFocus = document.activeElement as
    | (Element & { focus?: () => void; isConnected?: boolean })
    | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  // Keep the fallback inside an active modal so its focus event is not
  // rejected by the drawer focus trap on private-LAN HTTP pages.
  const activeDialog = previousFocus?.closest?.(
    "[role='dialog'][aria-modal='true']"
  );
  (activeDialog ?? document.body).append(textarea);

  try {
    textarea.focus();
    textarea.select();
    if (!document.execCommand("copy")) {
      throw new Error("Copy was not supported");
    }
  } finally {
    textarea.remove();
    if (
      previousFocus?.isConnected !== false &&
      typeof previousFocus?.focus === "function"
    ) {
      try {
        previousFocus.focus();
      } catch {
        // Focus restoration is best effort and must not mask copy failures.
      }
    }
  }
}
