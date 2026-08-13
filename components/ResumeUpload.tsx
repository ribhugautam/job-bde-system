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
        className="block w-full text-xs text-neutral-400 file:mr-3 file:rounded file:border-0 file:bg-neutral-800 file:px-3 file:py-1.5 file:text-xs file:text-neutral-200 hover:file:bg-neutral-700"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-50"
      >
        {busy ? "Uploading…" : "Upload resume"}
      </button>
      {msg && (
        <p className={`text-xs ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>
          {msg.text}
        </p>
      )}
    </form>
  );
}
