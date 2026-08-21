// ---------------------------------------------------------------------------
// Roles. Pure: no database, no React, no Next.js.
//
// Two roles, and deliberately not a permission system. There are exactly two
// decisions to make — "can this person manage other people?" and "can they use
// the app?" — and the second is answered by `isActive`, not by a role. A
// capability matrix here would be scaffolding for a product that does not
// exist.
// ---------------------------------------------------------------------------

export const USER_ROLES = ["admin", "member"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const DEFAULT_ROLE: UserRole = "member";

/** Total parsing: anything unrecognised degrades to the LEAST privileged role. */
export function parseRole(raw: string | null | undefined): UserRole {
  return (USER_ROLES as readonly string[]).includes(raw ?? "")
    ? (raw as UserRole)
    : DEFAULT_ROLE;
}

export function isAdmin(role: string | null | undefined): boolean {
  return parseRole(role) === "admin";
}

/**
 * Whether `actor` may invite, deactivate or re-role other people.
 *
 * A separate function from isAdmin() even though it is currently the same
 * test, because the two answer different questions: one is "what is this
 * person", the other is "may they do this". Call sites that read
 * `canManageUsers(...)` keep meaning the right thing if a third role ever
 * appears; call sites that read `isAdmin(...)` quietly stop.
 */
export function canManageUsers(role: string | null | undefined): boolean {
  return isAdmin(role);
}
