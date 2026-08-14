"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/domain/http/postJson";

// Every action here goes through postJson, which returns a result rather than
// throwing. These buttons previously parsed the body before checking res.ok and
// reset their busy flag after the parse, so a non-JSON 500 — what an uncaught
// exception in the route produces — left them stuck on "Sending..." with no
// error shown until the page was reloaded.
//
// The send buttons carry --ok because they ARE the "yes, do it" control for a
// deliberate, consequential action. That is the one non-chip use of the token
// the palette allows; the status selector is a neutral control and stays
// greyscale, and failures use --danger like every other error in the app.

export function SendApplicationButton({ applicationId }: { applicationId: number }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setLoading(true);
    setError(null);
    const res = await postJson("/api/actions/send-application", { applicationId });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        onClick={onClick}
        disabled={loading}
        className="rounded bg-(--ok-bg) px-3 py-1 text-xs font-medium text-(--ok-fg) hover:brightness-125 disabled:opacity-50"
      >
        {loading ? "Sending..." : "Approve & Send"}
      </button>
      {error && <span className="max-w-xs text-xs text-(--danger-fg)">{error}</span>}
    </div>
  );
}

export function SendOutreachButton({ outreachId }: { outreachId: number }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setLoading(true);
    setError(null);
    const res = await postJson("/api/actions/send-outreach", { outreachId });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        onClick={onClick}
        disabled={loading}
        className="rounded bg-(--ok-bg) px-3 py-1 text-xs font-medium text-(--ok-fg) hover:brightness-125 disabled:opacity-50"
      >
        {loading ? "Sending..." : "Approve & Send"}
      </button>
      {error && <span className="max-w-xs text-xs text-(--danger-fg)">{error}</span>}
    </div>
  );
}

export function StatusSelect({
  entity,
  id,
  status,
  options,
}: {
  entity: "job" | "lead";
  id: number;
  status: string;
  options: string[];
}) {
  const router = useRouter();
  const [value, setValue] = useState(status);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onChange(next: string) {
    const previous = value;
    setValue(next);
    setLoading(true);
    setError(null);
    const res = await postJson("/api/actions/update-status", { entity, id, status: next });
    setLoading(false);
    if (!res.ok) {
      // The select was showing the new status while the write had failed,
      // which reads as a save that happened. Put it back and say why.
      setValue(previous);
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <select
        value={value}
        disabled={loading}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-(--border-strong) bg-(--neutral-bg) px-2 py-1 text-xs text-(--text) disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      {error && (
        <span className="max-w-40 text-right text-[10px] text-(--danger-fg)">{error}</span>
      )}
    </span>
  );
}
