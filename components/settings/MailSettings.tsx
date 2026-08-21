"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/infra/http/postJson";
import type { MailSettingsView } from "@/lib/infra/db/user-mail";

export default function MailSettings({ settings }: { settings: MailSettingsView }) {
  const router = useRouter();
  const [smtpUser, setSmtpUser] = useState(settings.smtpUser ?? "");
  const [fromName, setFromName] = useState(settings.fromName ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function send(body: Record<string, unknown>, okNote: string) {
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await postJson("/api/actions/update-mail", body);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNote(okNote);
    // Cleared on success so a real credential does not sit in a form field for
    // the rest of the session.
    setPassword("");
    router.refresh();
  }

  if (!settings.encryptionAvailable) {
    return (
      <div className="rounded border border-(--danger-fg) bg-(--danger-bg) p-3">
        <div className="text-sm font-semibold text-(--danger-fg)">
          Mailbox setup unavailable
        </div>
        <div className="mt-1 text-xs text-(--text-muted)">
          <code className="font-mono">ENCRYPTION_KEY</code> is not set on this
          deployment, so mailbox passwords cannot be stored securely. Until an
          admin sets one (<code className="font-mono">openssl rand -hex 32</code>
          ), applications are drafted and queued rather than sent.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded border border-(--border) p-3">
      {/*
        The state is stated plainly, because "saved" and "will actually send"
        are different things and the gap between them is where a silent failure
        lives. A saved-but-unverified mailbox sends nothing.
      */}
      {settings.configured ? (
        settings.verifiedAt ? (
          <div className="text-xs text-(--ok-fg)">
            Sending as{" "}
            <span className="font-mono">{settings.smtpUser}</span> — verified{" "}
            {new Date(settings.verifiedAt).toLocaleDateString()}. Auto-send is on
            for your applications.
          </div>
        ) : (
          <div className="text-xs text-(--warn-fg)">
            <span className="font-mono">{settings.smtpUser}</span> is saved but
            not verified, so nothing is sent automatically — your drafts queue
            for one-click sending instead.
            {settings.lastError && (
              <span className="mt-1 block text-(--danger-fg)">
                Last attempt: {settings.lastError}
              </span>
            )}
          </div>
        )
      ) : (
        <div className="text-xs text-(--text-dim)">
          No mailbox set up. Your applications are drafted and queued for
          one-click sending. Add a mailbox to let them go out automatically.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          value={smtpUser}
          onChange={(e) => setSmtpUser(e.target.value)}
          placeholder="you@gmail.com"
          className="w-56 rounded border border-(--border-strong) bg-transparent px-2 py-1 text-xs text-(--text) placeholder:text-(--text-faint)"
        />
        <input
          value={fromName}
          onChange={(e) => setFromName(e.target.value)}
          placeholder="Display name"
          className="w-40 rounded border border-(--border-strong) bg-transparent px-2 py-1 text-xs text-(--text) placeholder:text-(--text-faint)"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          placeholder="16-char app password"
          className="w-48 rounded border border-(--border-strong) bg-transparent px-2 py-1 text-xs text-(--text) placeholder:text-(--text-faint)"
        />
        <button
          onClick={() =>
            send(
              { action: "save", smtpUser, password, fromName },
              "Saved and verified. Auto-send is on."
            )
          }
          disabled={busy || !smtpUser.includes("@") || password.length === 0}
          className="rounded bg-(--ok-bg) px-3 py-1 text-xs font-medium text-(--ok-fg) hover:brightness-125 disabled:opacity-50"
        >
          {busy ? "Checking..." : "Save & verify"}
        </button>

        {settings.configured && (
          <>
            <button
              onClick={() => send({ action: "verify" }, "Verified.")}
              disabled={busy}
              className="rounded border border-(--border-strong) px-2 py-1 text-xs text-(--text-muted) hover:text-(--text) disabled:opacity-50"
            >
              Re-test
            </button>
            <button
              onClick={() => send({ action: "delete" }, "Mailbox removed.")}
              disabled={busy}
              className="rounded border border-(--border-strong) px-2 py-1 text-xs text-(--text-muted) hover:text-(--danger-fg) disabled:opacity-50"
            >
              Remove
            </button>
          </>
        )}
      </div>

      <p className="text-[11px] text-(--text-faint)">
        Gmail needs an{" "}
        <a
          href="https://myaccount.google.com/apppasswords"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-(--text-muted)"
        >
          App Password
        </a>{" "}
        (2-Step Verification must be on) — not your normal password. It is
        encrypted before storage and never shown again.
      </p>

      {note && <p className="text-xs text-(--ok-fg)">{note}</p>}
      {error && <p className="text-xs text-(--danger-fg)">{error}</p>}
    </div>
  );
}
