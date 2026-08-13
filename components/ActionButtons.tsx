"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SendApplicationButton({ applicationId }: { applicationId: number }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setLoading(true);
    setError(null);
    const res = await fetch("/api/actions/send-application", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ applicationId }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error || "failed");
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        onClick={onClick}
        disabled={loading}
        className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
      >
        {loading ? "Sending..." : "Approve & Send"}
      </button>
      {error && <span className="text-xs text-red-400 max-w-xs">{error}</span>}
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
    const res = await fetch("/api/actions/send-outreach", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outreachId }),
    });
    const data = await res.json();
    setLoading(false);
    if (!res.ok) {
      setError(data.error || "failed");
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        onClick={onClick}
        disabled={loading}
        className="rounded bg-emerald-700 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
      >
        {loading ? "Sending..." : "Approve & Send"}
      </button>
      {error && <span className="text-xs text-red-400 max-w-xs">{error}</span>}
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

  async function onChange(next: string) {
    setValue(next);
    setLoading(true);
    await fetch("/api/actions/update-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entity, id, status: next }),
    });
    setLoading(false);
    router.refresh();
  }

  return (
    <select
      value={value}
      disabled={loading}
      onChange={(e) => onChange(e.target.value)}
      className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {o.replace(/_/g, " ")}
        </option>
      ))}
    </select>
  );
}
