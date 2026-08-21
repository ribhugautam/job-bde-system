"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/infra/http/postJson";
import { USER_ROLES, type UserRole } from "@/lib/domain/users/roles";

// Every control here goes through postJson, which returns a result rather than
// throwing — the same reason ActionButtons.tsx does: a non-JSON 500 used to
// leave buttons latched on "Saving..." with no error shown.

export function InviteForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("member");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setLink(null);
    const res = await postJson("/api/admin/invites", { email, role });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // postJson types `data` as unknown on purpose, so narrow rather than
    // assert. A 200 with an unexpected body is a real (if unlikely) case and
    // reads better as an error than as `undefined` rendered into the panel.
    const url = (res.data as { url?: unknown } | null)?.url;
    if (typeof url !== "string") {
      setError("The invite was created but the server did not return a link.");
      return;
    }
    // Shown, not emailed. This deployment has one outbound mailbox and it is
    // used for applications; quietly borrowing it to send account mail would
    // put invite delivery at the mercy of the same rate limits.
    setLink(url);
    setEmail("");
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="rounded border border-(--border) p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="colleague@company.com"
          className="w-64 rounded border border-(--border-strong) bg-transparent px-2 py-1 text-xs text-(--text) placeholder:text-(--text-faint)"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as UserRole)}
          className="rounded border border-(--border-strong) bg-transparent px-1.5 py-1 text-xs text-(--text-muted)"
        >
          {USER_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={loading || !email.includes("@")}
          className="rounded bg-(--ok-bg) px-3 py-1 text-xs font-medium text-(--ok-fg) hover:brightness-125 disabled:opacity-50"
        >
          {loading ? "Creating..." : "Create invite"}
        </button>
      </div>

      {link && (
        <div className="mt-3 rounded border border-(--info-bg) bg-(--info-bg) p-2">
          <div className="text-xs text-(--info-fg)">
            Send this link to them. It works once, expires in 7 days, and cannot
            be shown again.
          </div>
          <code className="mt-1 block break-all font-mono text-[11px] text-(--text)">
            {link}
          </code>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-(--danger-fg)">{error}</p>}
    </form>
  );
}

export function RevokeInviteButton({ id }: { id: number }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setLoading(true);
    setError(null);
    const res = await postJson("/api/admin/invites/revoke", { id });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={onClick}
        disabled={loading}
        className="rounded border border-(--border-strong) px-2 py-0.5 text-[11px] text-(--text-muted) hover:text-(--text) disabled:opacity-50"
      >
        {loading ? "..." : "Revoke"}
      </button>
      {error && <span className="text-[11px] text-(--danger-fg)">{error}</span>}
    </div>
  );
}

export function UserControls({
  userId,
  role,
  isActive,
  isSelf,
}: {
  userId: number;
  role: UserRole;
  isActive: boolean;
  isSelf: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(body: Record<string, unknown>) {
    setLoading(true);
    setError(null);
    const res = await postJson("/api/admin/users", { userId, ...body });
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <select
          value={role}
          disabled={loading || isSelf}
          onChange={(e) => send({ role: e.target.value })}
          className="rounded border border-(--border-strong) bg-transparent px-1.5 py-0.5 text-[11px] text-(--text-muted) disabled:opacity-40"
        >
          {USER_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          onClick={() => send({ isActive: !isActive })}
          disabled={loading || isSelf}
          className="rounded border border-(--border-strong) px-2 py-0.5 text-[11px] text-(--text-muted) hover:text-(--text) disabled:opacity-40"
        >
          {loading ? "..." : isActive ? "Deactivate" : "Reactivate"}
        </button>
      </div>
      {/*
        Disabled rather than hidden for your own row, with the reason stated.
        A control that silently vanishes reads as a bug; one that explains
        itself reads as a guardrail.
      */}
      {isSelf && (
        <span className="text-[11px] text-(--text-faint)">
          you cannot change your own access
        </span>
      )}
      {error && <span className="max-w-xs text-[11px] text-(--danger-fg)">{error}</span>}
    </div>
  );
}
