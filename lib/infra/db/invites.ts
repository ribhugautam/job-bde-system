import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb, schema } from "./client";
import { randomHex } from "@/lib/infra/crypto/password";
import {
  inviteExpiry,
  inviteState,
  describeInviteState,
  type InviteState,
} from "@/lib/domain/users/invites";
import { createUser, normalizeEmail, type PublicUser } from "./users";
import type { UserRole } from "@/lib/domain/users/roles";

// ---------------------------------------------------------------------------
// Invite storage and redemption.
//
// The token IS the credential — holding it is what proves you were invited —
// so it is 32 random bytes from crypto.getRandomValues, never derived from the
// email. A guessable token would make "invite-only" decorative.
// ---------------------------------------------------------------------------

const TOKEN_BYTES = 32;

export type InviteSummary = {
  id: number;
  email: string;
  role: UserRole;
  state: InviteState;
  expiresAt: Date;
  createdAt: Date | null;
  /** Present only immediately after creation — see createInvite(). */
  token?: string;
};

export async function createInvite(opts: {
  email: string;
  role: UserRole;
  createdByUserId: number;
}): Promise<{ ok: true; token: string; id: number } | { ok: false; error: string }> {
  const email = normalizeEmail(opts.email);
  if (!email.includes("@")) return { ok: false, error: "That is not an email address." };

  const db = getDb();

  // An outstanding invite for the same address is revoked rather than left to
  // coexist. Two live tokens for one person means the first link keeps working
  // after the second is sent, which is not what "I re-sent the invite" means.
  await db
    .update(schema.invites)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.invites.email, email),
        isNull(schema.invites.acceptedAt),
        isNull(schema.invites.revokedAt)
      )
    );

  const token = randomHex(TOKEN_BYTES);
  const [row] = await db
    .insert(schema.invites)
    .values({
      token,
      email,
      role: opts.role,
      expiresAt: inviteExpiry(),
      createdByUserId: opts.createdByUserId,
    })
    .returning();

  // The token is returned exactly once, here, so the admin can copy the link.
  // It is stored in full rather than hashed: unlike a password it is short-
  // lived, single-use and already visible to whoever can read the admin page.
  return { ok: true, token, id: row.id };
}

export async function listInvites(): Promise<InviteSummary[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.invites)
    .orderBy(desc(schema.invites.id));

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role as UserRole,
    state: inviteState(row),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }));
}

export async function revokeInvite(id: number): Promise<void> {
  const db = getDb();
  await db
    .update(schema.invites)
    .set({ revokedAt: new Date() })
    .where(and(eq(schema.invites.id, id), isNull(schema.invites.acceptedAt)));
}

export type InviteLookup =
  | { ok: true; email: string; role: UserRole }
  | { ok: false; error: string };

/** Read-only check, for rendering the accept form before anything is created. */
export async function lookupInvite(token: string): Promise<InviteLookup> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.token, token))
    .limit(1);

  if (!row) return { ok: false, error: "This invite link is not valid." };

  const state = inviteState(row);
  if (state !== "valid") return { ok: false, error: describeInviteState(state) };

  return { ok: true, email: row.email, role: row.role as UserRole };
}

export type AcceptResult =
  | { ok: true; user: PublicUser }
  | { ok: false; error: string };

/**
 * Redeems an invite and creates the account.
 *
 * The invite is marked accepted only AFTER the user row exists. The other
 * order would spend the token on a failed signup and leave the person holding
 * a dead link and no account.
 *
 * This is not transactional — libSQL over HTTP has no interactive transaction
 * here — so the residual risk is the mirror case: the account is created and
 * the mark-accepted write fails, leaving a spent-looking invite still valid.
 * That collapses to "the same person could accept twice", and the second
 * attempt fails on the unique email index. A duplicate-account race was worth
 * ruling out; a rare orphaned token that cannot create anything is not.
 */
export async function acceptInvite(opts: {
  token: string;
  name: string;
  password: string;
}): Promise<AcceptResult> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.invites)
    .where(eq(schema.invites.token, opts.token))
    .limit(1);

  if (!row) return { ok: false, error: "This invite link is not valid." };

  const state = inviteState(row);
  if (state !== "valid") return { ok: false, error: describeInviteState(state) };

  const created = await createUser({
    email: row.email,
    name: opts.name,
    password: opts.password,
    role: row.role as UserRole,
  });
  if (!created.ok) return created;

  await db
    .update(schema.invites)
    .set({ acceptedAt: new Date(), acceptedByUserId: created.user.id })
    .where(eq(schema.invites.id, row.id));

  return { ok: true, user: created.user };
}
