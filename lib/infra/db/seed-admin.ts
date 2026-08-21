import { isNull } from "drizzle-orm";
import { getDb, schema } from "./client";
import {
  countUsers,
  createUser,
  findUserByEmail,
  getOwnerUserId,
} from "./users";

// ---------------------------------------------------------------------------
// The anti-lockout guarantee.
//
// Before this feature, one APP_PASSWORD unlocked the app and there were no
// accounts. The moment the `users` table starts gating sign-in, a deployment
// with zero rows in it is a deployment nobody can enter — including the person
// who owns it, and including to create the first account. Registration is
// invite-only, and there is nobody to issue the first invite.
//
// So the first admin is minted from credentials the operator already has:
// OWNER_EMAIL (falling back to GMAIL_USER) and APP_PASSWORD. Idempotent, and
// it only ever fires into an empty table — it can neither overwrite a real
// account nor quietly re-create one that was deliberately deactivated.
// ---------------------------------------------------------------------------

export type SeedResult =
  | { created: true; email: string }
  | { created: false; reason: string };

export async function ensureFirstAdmin(): Promise<SeedResult> {
  // The guard is "no users at all", not "no admins". Re-seeding into a
  // populated table would hand APP_PASSWORD-level access to whoever still knows
  // that value, long after real accounts replaced it.
  if ((await countUsers()) > 0) {
    return { created: false, reason: "users already exist; nothing to seed" };
  }

  const email = process.env.OWNER_EMAIL || process.env.GMAIL_USER;
  const password = process.env.APP_PASSWORD;

  if (!email) {
    return {
      created: false,
      reason:
        "cannot seed the first admin: set OWNER_EMAIL (or GMAIL_USER) to the " +
        "address you want to sign in with, then re-run `npm run db:migrate`",
    };
  }
  if (!password) {
    return {
      created: false,
      reason:
        "cannot seed the first admin: APP_PASSWORD is not set. It becomes the " +
        "first admin's password and can be changed after signing in",
    };
  }

  if (await findUserByEmail(email)) {
    return { created: false, reason: `${email} already has an account` };
  }

  const result = await createUser({
    email,
    // A placeholder the operator can correct on their profile page. Deriving a
    // name from an email address guesses at a real person's name and gets it
    // wrong often enough to be worse than saying nothing.
    name: "Admin",
    password,
    role: "admin",
  });

  if (!result.ok) {
    return { created: false, reason: `could not create the first admin: ${result.error}` };
  }

  return { created: true, email: result.user.email };
}

/**
 * Assigns pre-accounts rows to the owner.
 *
 * `documents.user_id` had to be added as NULLABLE — the column did not exist
 * when those rows were written, and ALTER TABLE has no correct value to invent.
 * Left null they would belong to nobody: getActiveResume() is scoped to a user
 * and has NO "any active resume" fallback, deliberately, because that fallback
 * would attach one person's CV to another person's application.
 *
 * So the resume uploaded when this deployment had exactly one user is assigned
 * to that user. Run on every migrate, not just the seeding one, so a database
 * migrated before the admin existed is still repaired on the next run.
 */
export async function claimOrphanedRecords(): Promise<{
  documents: number;
  applications: number;
  outreach: number;
}> {
  const ownerId = await getOwnerUserId();
  if (ownerId === null) {
    return { documents: 0, applications: 0, outreach: 0 };
  }

  const db = getDb();

  // Applications and outreach are a record of email that really was sent, from
  // the one mailbox this deployment had. Their sender is not a guess.
  const [apps, pitches] = await Promise.all([
    db
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .where(isNull(schema.applications.userId)),
    db
      .select({ id: schema.outreach.id })
      .from(schema.outreach)
      .where(isNull(schema.outreach.userId)),
  ]);

  if (apps.length) {
    await db
      .update(schema.applications)
      .set({ userId: ownerId })
      .where(isNull(schema.applications.userId));
  }
  if (pitches.length) {
    await db
      .update(schema.outreach)
      .set({ userId: ownerId })
      .where(isNull(schema.outreach.userId));
  }

  return {
    documents: await claimOrphanedDocuments(),
    applications: apps.length,
    outreach: pitches.length,
  };
}

export async function claimOrphanedDocuments(): Promise<number> {
  const ownerId = await getOwnerUserId();
  if (ownerId === null) return 0;

  const db = getDb();
  const orphans = await db
    .select({ id: schema.documents.id })
    .from(schema.documents)
    .where(isNull(schema.documents.userId));
  if (orphans.length === 0) return 0;

  await db
    .update(schema.documents)
    .set({ userId: ownerId })
    .where(isNull(schema.documents.userId));

  return orphans.length;
}
