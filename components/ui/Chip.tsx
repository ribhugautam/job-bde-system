import type { ReactNode } from "react";

/**
 * Tones map to MEANING, not to decoration:
 *   ok      you can take this job
 *   info    no restriction was stated
 *   warn    requires office presence
 *   danger  you cannot take this job
 *   neutral a fact with no verdict attached
 */
export type ChipTone = "ok" | "info" | "warn" | "danger" | "neutral";

const TONE: Record<ChipTone, string> = {
  ok: "bg-(--ok-bg) text-(--ok-fg)",
  info: "bg-(--info-bg) text-(--info-fg)",
  warn: "bg-(--warn-bg) text-(--warn-fg)",
  danger: "bg-(--danger-bg) text-(--danger-fg)",
  neutral: "bg-(--neutral-bg) text-(--neutral-fg)",
};

export default function Chip({
  tone = "neutral",
  children,
}: {
  tone?: ChipTone;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-block shrink-0 rounded px-1.5 py-px text-[10px] font-medium leading-4 ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}
