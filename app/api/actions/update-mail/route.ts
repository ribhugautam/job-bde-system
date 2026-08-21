import { NextRequest, NextResponse } from "next/server";
import { getApiActor } from "@/lib/infra/session";
import {
  deleteMailSettings,
  markMailFailed,
  markMailVerified,
  saveMailSettings,
} from "@/lib/infra/db/user-mail";
import { verifyIdentity } from "@/lib/infra/mail/send";
import { decryptSecret } from "@/lib/infra/crypto/secret";
import { getDb, schema } from "@/lib/infra/db/client";
import { eq } from "drizzle-orm";
import { findUserById } from "@/lib/infra/db/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Saves, verifies, or removes the CALLING USER's sending mailbox.
 *
 * Always the caller's own: the user id comes from the session and is never
 * accepted from the body. There is no admin override — an admin setting up
 * somebody else's mailbox would mean storing a credential that person never
 * handed over.
 *
 * The stored password is never echoed back in any response.
 */
export async function POST(req: NextRequest) {
  const actor = await getApiActor();
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const action = typeof body.action === "string" ? body.action : "save";

  if (action === "delete") {
    await deleteMailSettings(actor.user.id);
    return NextResponse.json({ ok: true });
  }

  if (action === "verify") {
    // Verifying an ALREADY-STORED mailbox, so the password is read back out of
    // the row rather than being re-typed. getSenderIdentity() refuses
    // unverified rows by design, so this reads the row directly.
    const db = getDb();
    const [row] = await db
      .select()
      .from(schema.userMail)
      .where(eq(schema.userMail.userId, actor.user.id))
      .limit(1);
    if (!row) {
      return NextResponse.json({ error: "No mailbox saved yet." }, { status: 400 });
    }

    const password = await decryptSecret(row.smtpPasswordEncrypted);
    if (!password) {
      return NextResponse.json(
        {
          error:
            "The stored password could not be decrypted — ENCRYPTION_KEY has " +
            "probably changed. Re-enter your app password.",
        },
        { status: 400 }
      );
    }

    const user = await findUserById(actor.user.id);
    const result = await verifyIdentity({
      user: row.smtpUser,
      password,
      fromName: row.fromName || user?.name || row.smtpUser,
      host: row.smtpHost,
      port: row.smtpPort,
    });

    if (!result.ok) {
      await markMailFailed(actor.user.id, result.error);
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    await markMailVerified(actor.user.id);
    return NextResponse.json({ ok: true, verified: true });
  }

  const smtpUser = typeof body.smtpUser === "string" ? body.smtpUser : "";
  const password = typeof body.password === "string" ? body.password : "";
  const fromName = typeof body.fromName === "string" ? body.fromName : undefined;
  const smtpHost = typeof body.smtpHost === "string" ? body.smtpHost : undefined;
  const smtpPort =
    typeof body.smtpPort === "number" && Number.isSafeInteger(body.smtpPort)
      ? body.smtpPort
      : undefined;

  const saved = await saveMailSettings({
    userId: actor.user.id,
    smtpUser,
    password,
    fromName,
    smtpHost,
    smtpPort,
  });
  if (!saved.ok) {
    return NextResponse.json({ error: saved.error }, { status: 400 });
  }

  // Verified immediately on save, so a typo is caught here rather than at the
  // moment a real application would have gone out. A save that stores fine but
  // cannot authenticate is reported as an error even though the row was
  // written — the row is useless until it verifies, and saying "saved" would
  // imply auto-send is now on when it is not.
  const identity = await getSenderIdentityForVerification(actor.user.id);
  if (!identity) {
    return NextResponse.json({ ok: true, verified: false });
  }

  const result = await verifyIdentity(identity);
  if (!result.ok) {
    await markMailFailed(actor.user.id, result.error);
    return NextResponse.json(
      { error: `Saved, but the mail server refused the login: ${result.error}` },
      { status: 400 }
    );
  }

  await markMailVerified(actor.user.id);
  return NextResponse.json({ ok: true, verified: true });
}

/**
 * Reads back a just-saved row for its first verification.
 *
 * getSenderIdentity() deliberately refuses unverified rows, which is right for
 * every other caller and exactly wrong here — this is the code path that makes
 * a row verified in the first place.
 */
async function getSenderIdentityForVerification(userId: number) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.userMail)
    .where(eq(schema.userMail.userId, userId))
    .limit(1);
  if (!row) return null;

  const password = await decryptSecret(row.smtpPasswordEncrypted);
  if (!password) return null;

  const user = await findUserById(userId);
  return {
    user: row.smtpUser,
    password,
    fromName: row.fromName || user?.name || row.smtpUser,
    host: row.smtpHost,
    port: row.smtpPort,
  };
}
