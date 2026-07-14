import type { ReactNode } from "react";

import type { Tone } from "@/lib/presenters";

export function StatusChip({
  children,
  icon,
  tone = "neutral"
}: {
  children: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
}) {
  return (
    <span className={`status-chip status-chip--${tone}`}>
      {icon}
      <span>{children}</span>
    </span>
  );
}
