import { and, asc, count, eq, ne } from "drizzle-orm";
import { getDb, schema } from "./client";
import { hashPassword, verifyPassword, needsRehash } from "@/lib/infra/crypto/password";
import { parseRole, type UserRole } from "@/lib/domain/users/roles";
import { MIN_PASSWORD_LENGTH } from "@/lib/config/auth-policy";

// ---------------------------------------------------------------------------
// Everything that reads or writes the `users` table.
//
// The password hash NEVER leaves this module. Every function here returns
// PublicUser, which structurally cannot carry it — so a page that renders a
// user, or an API route that serialises one, has no way to leak it by
// forgetting to strip a field.
// ---------------------------------------------------------------------------

export type PublicUser = {
  id: number;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  lastSeenAt: Date | null;
  createdAt: Date | null;
};

type UserRow = typeof schema.users.$inferSelect;

function toPublic(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: parseRole(row.role),
    isActive: row.isActive,
    lastSeenAt: row.lastSeenAt,
    createdAt: row.createdAt,
  };
}

/**
 * Lowercase + trim. Applied on every read AND every write.
 *
 * The unique index is on the raw column, so it only prevents duplicates that
 * are byte-identical. Without normalising here, `Alice@x.com` and
 * `alice@x.com` are two accounts that both believe they are the same person.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export type CreateUserResult =
  | { ok: true; user: PublicUser }
  | { ok: false; error: string };

export async function createUser(opts: {
  email: string;
  name: string;
  password: string;
  role?: UserRole;
}): Promise<CreateUserResult> {
  const email = normalizeEmail(opts.email);
  const name = opts.name.trim();

  if (!email.includes("@")) return { ok: false, error: "That is not an email address." };
  if (!name) return { ok: false, error: "Name is required." };
  if (opts.password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }

  const db = getDb();
  const existing = await findUserByEmail(email);
  if (existing) return { ok: false, error: "An account with that email already exists." };

  const [row] = await db
    .insert(schema.users)
    .values({
      email,
      name,
      passwordHash: await hashPassword(opts.password),
      role: opts.role ?? "member",
    })
    .returning();

  return { ok: true, user: toPublic(row) };
}

export async function findUserByEmail(email: string): Promise<PublicUser | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, normalizeEmail(email)))
    .limit(1);
  return row ? toPublic(row) : null;
}

export async function findUserById(id: number): Promise<PublicUser | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, id))
    .limit(1);
  return row ? toPublic(row) : null;
}

/**
 * Checks an email/password pair and returns the user, or null.
 *
 * Returns null identically for "no such user", "wrong password" and "account
 * deactivated". The caller shows one message for all three: distinguishing
 * them turns the login form into an account-existence oracle, and a
 * deactivated person learning they were deactivated from a login screen is
 * not the way to find out.
 *
 * A successful login also transparently upgrades the stored hash if the cost
 * factor has been raised since it was written — the one moment the plaintext
 * is legitimately available to re-derive it.
 */
export async function authenticate(
  email: string,
  password: string
): Promise<PublicUser | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, normalizeEmail(email)))
    .limit(1);

  if (!row) {
    // Deliberate: burn comparable CPU on a miss so response time does not
    // separate "no such account" from "wrong password".
    await verifyPassword(password, "pbkdf2-sha256$600000$00$00");
    return null;
  }

  if (!(await verifyPassword(password, row.passwordHash))) return null;
  if (!row.isActive) return null;

  if (needsRehash(row.passwordHash)) {
    await db
      .update(schema.users)
      .set({ passwordHash: await hashPassword(password), updatedAt: new Date() })
      .where(eq(schema.users.id, row.id));
  }

  return toPublic(row);
}

export async function listUsers(): Promise<PublicUser[]> {
  const db = getDb();
  const rows = await db.select().from(schema.users).orderBy(asc(schema.users.id));
  return rows.map(toPublic);
}

export async function countActiveAdmins(excludeUserId?: number): Promise<number> {
  const db = getDb();
  const where = [eq(schema.users.role, "admin"), eq(schema.users.isActive, true)];
  if (excludeUserId !== undefined) where.push(ne(schema.users.id, excludeUserId));
  const [row] = await db
    .select({ n: count() })
    .from(schema.users)
    .where(and(...where));
  return row?.n ?? 0;
}

export type AdminActionResult = { ok: true } | { ok: false; error: string };

/**
 * Deactivating the last active admin would leave the deployment with nobody
 * able to invite, re-role or reactivate anyone — recoverable only by editing
 * the database by hand. Refused rather than warned about.
 */
export async function setUserActive(
  userId: number,
  isActive: boolean
): Promise<AdminActionResult> {
  const db = getDb();
  const user = await findUserById(userId);
  if (!user) return { ok: false, error: "No such user." };

  if (!isActive && user.role === "admin" && (await countActiveAdmins(userId)) === 0) {
    return {
      ok: false,
      error:
        "This is the only active admin. Promote someone else first, or you will " +
        "lock everyone out of user management.",
    };
  }

  await db
    .update(schema.users)
    .set({ isActive, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
  return { ok: true };
}

/** Same last-admin guard as deactivation, for the same reason. */
export async function setUserRole(
  userId: number,
  role: UserRole
): Promise<AdminActionResult> {
  const db = getDb();
  const user = await findUserById(userId);
  if (!user) return { ok: false, error: "No such user." };

  if (role !== "admin" && user.role === "admin" && (await countActiveAdmins(userId)) === 0) {
    return {
      ok: false,
      error:
        "This is the only active admin. Promote someone else before demoting them.",
    };
  }

  await db
    .update(schema.users)
    .set({ role, updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
  return { ok: true };
}

export async function setPassword(
  userId: number,
  password: string
): Promise<AdminActionResult> {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  const db = getDb();
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(password), updatedAt: new Date() })
    .where(eq(schema.users.id, userId));
  return { ok: true };
}

/** Fire-and-forget: a failed marker update must never break a page render. */
export async function touchLastSeen(userId: number): Promise<void> {
  try {
    const db = getDb();
    await db
      .update(schema.users)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.users.id, userId));
  } catch {
    // Intentionally swallowed. This powers a "new since you looked" badge; a
    // write failure here is not worth a 500 on the dashboard.
  }
}

export async function countUsers(): Promise<number> {
  const db = getDb();
  const [row] = await db.select({ n: count() }).from(schema.users);
  return row?.n ?? 0;
}

/**
 * The lowest-numbered active admin — i.e. whoever the deployment belongs to.
 *
 * A STOPGAP for the unattended pipeline, which predates accounts and still runs
 * one shared queue rather than one per person. Where it used to read "the"
 * resume and "the" sending identity, it now reads the owner's, which is exactly
 * the same row it read before. Per-user drafting and dispatch replaces every
 * call to this; nothing new should start using it.
 */
export async function getOwnerUserId(): Promise<number | null> {
  const db = getDb();
  const [row] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.role, "admin"), eq(schema.users.isActive, true)))
    .orderBy(asc(schema.users.id))
    .limit(1);
  return row?.id ?? null;
}
