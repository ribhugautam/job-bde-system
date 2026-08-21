import { countUsers, createUser, findUserByEmail } from "./users";

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
