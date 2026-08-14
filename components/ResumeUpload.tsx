"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function ResumeUpload() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const file = data.get("resume");
    if (!file || typeof file === "string" || file.size === 0) {
      setMsg({ ok: false, text: "Pick a PDF first." });
      return;
    }

    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/actions/upload-resume", {
        method: "POST",
        body: data,
      });
      const json = await res.json();
      if (res.ok && json.ok) {
        setMsg({
          ok: true,
          text: `Uploaded (${(json.sizeBytes / 1024).toFixed(0)} KB). This is now the CV attached to every application.`,
        });
        form.reset();
        router.refresh();
      } else {
        setMsg({ ok: false, text: json.error || `Upload failed (${res.status}).` });
      }
    } catch (err) {
      setMsg({
        ok: false,
        text: err instanceof Error ? err.message : "Upload failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <input
        type="file"
        name="resume"
        accept="application/pdf,.pdf"
        className="block w-full text-xs text-(--text-muted) file:mr-3 file:rounded file:border-0 file:bg-(--neutral-bg) file:px-3 file:py-1.5 file:text-xs file:text-(--text) hover:file:brightness-125"
      />
      {/*
        Greyscale, deliberately. Green means "takeable" in this palette and is
        reserved for the send controls; an upload is a neutral action, and
        colouring it would make the token mean two things.
      */}
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-(--neutral-bg) px-3 py-1.5 text-xs font-medium text-(--text) hover:brightness-125 disabled:opacity-50"
      >
        {busy ? "Uploading…" : "Upload resume"}
      </button>
      {msg && (
        <p className={`text-xs ${msg.ok ? "text-(--ok-fg)" : "text-(--danger-fg)"}`}>
          {msg.text}
        </p>
      )}
    </form>
  );
}
