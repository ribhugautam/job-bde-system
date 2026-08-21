"use client";

import { useState } from "react";
import { MIN_PASSWORD_LENGTH } from "@/lib/config/auth-policy";

export function AcceptForm({ token, email }: { token: string; email: string }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready =
    name.trim().length > 0 &&
    password.length >= MIN_PASSWORD_LENGTH &&
    confirm === password;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/accept-invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoading(false);
        setError(data.error || "could not create your account");
        return;
      }
      // The route signs the new user in, so go straight to the dashboard.
      //
      // A FULL navigation, not router.push(), and the same choice LoginForm
      // makes for the same reason: the session cookie was set by the fetch
      // above, and a client-side transition can still be served from the
      // router cache populated before it existed. A document load cannot be.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/dashboard";
    } catch {
      setLoading(false);
      setError("Could not reach the server. Check your connection and retry.");
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6"
    >
      <h1 className="text-lg font-semibold text-neutral-100">Create your account</h1>
      <p className="mt-1 text-sm text-neutral-500">
        Invited as <span className="text-neutral-300">{email}</span>
      </p>
      {/*
        The email is fixed by the invite and shown read-only rather than as an
        editable field. Letting it be changed here would turn one invite into a
        way to create an account for any address at all.
      */}
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        autoComplete="name"
        placeholder="Your name"
        className="mt-4 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
        placeholder={`Password (${MIN_PASSWORD_LENGTH}+ characters)`}
        className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
      />
      <input
        type="password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        autoComplete="new-password"
        placeholder="Confirm password"
        className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
      />
      <button
        type="submit"
        disabled={loading || !ready}
        className="mt-3 w-full rounded bg-white px-3 py-2 text-sm font-medium text-black hover:bg-neutral-200 disabled:opacity-50"
      >
        {loading ? "Creating..." : "Create account"}
      </button>
      {tooShort && (
        <p className="mt-3 text-xs text-neutral-500">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
      )}
      {mismatch && (
        <p className="mt-3 text-xs text-neutral-500">Passwords do not match.</p>
      )}
      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
    </form>
  );
}
