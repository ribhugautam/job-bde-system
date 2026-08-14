"use client";

export function LogoutButton() {
  async function onClick() {
    await fetch("/api/auth/logout", { method: "POST" });
    // Deliberately a full page load rather than router.push: it throws away the
    // client-side RSC cache, so hitting Back after signing out cannot re-render
    // dashboard data from memory.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  }

  return (
    <button
      onClick={onClick}
      className="text-xs text-(--text-dim) transition hover:text-(--text)"
    >
      Sign out
    </button>
  );
}
