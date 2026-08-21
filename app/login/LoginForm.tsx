"use client";

import { useState } from "react";

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoading(false);
        setError(data.error || "login failed");
        return;
      }
      // Full navigation, not router.push: the server needs to see the new cookie
      // on the very next request for the gated page to render.
      window.location.href = next;
    } catch {
      // Without this the button latches disabled forever on a network failure.
      setLoading(false);
      setError("Could not reach the server. Check your connection and retry.");
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-6"
    >
      <h1 className="text-lg font-semibold text-neutral-100">Sign in</h1>
      <p className="mt-1 text-sm text-neutral-500">
        This pipeline is private. Accounts are invite-only.
      </p>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        autoFocus
        autoComplete="username"
        placeholder="you@company.com"
        className="mt-4 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        placeholder="Password"
        className="mt-2 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-500"
      />
      <button
        type="submit"
        disabled={loading || email.length === 0 || password.length === 0}
        className="mt-3 w-full rounded bg-white px-3 py-2 text-sm font-medium text-black hover:bg-neutral-200 disabled:opacity-50"
      >
        {loading ? "Checking..." : "Sign in"}
      </button>
      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
    </form>
  );
}
