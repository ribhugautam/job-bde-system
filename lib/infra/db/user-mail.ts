import { eq } from "drizzle-orm";
import { getDb, schema } from "./client";
import {
  decryptSecret,
  encryptSecret,
  encryptionConfigured,
} from "@/lib/infra/crypto/secret";
import { findUserById } from "./users";

// ---------------------------------------------------------------------------
// Each person's outbound mailbox.
//
// The decrypted password NEVER leaves this module except inside a SenderIdentity
// handed straight to nodemailer. Everything the UI sees goes through
// MailSettingsView, which structurally cannot carry it.
// ---------------------------------------------------------------------------

/** What the settings page may see. No secret material, by construction. */
export type MailSettingsView = {
  configured: boolean;
  smtpUser: string | null;
  fromName: string | null;
  smtpHost: string;
  smtpPort: number;
  verifiedAt: Date | null;
  lastError: string | null;
  /** False when ENCRYPTION_KEY is missing, so nothing can be stored at all. */
  encryptionAvailable: boolean;
};

/** Everything nodemailer needs to send as this person. */
export type SenderIdentity = {
  user: string;
  password: string;
  fromName: string;
  host: string;
  port: number;
};

export async function getMailSettings(userId: number): Promise<MailSettingsView> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.userMail)
    .where(eq(schema.userMail.userId, userId))
    .limit(1);

  return {
    configured: Boolean(row),
    smtpUser: row?.smtpUser ?? null,
    fromName: row?.fromName ?? null,
    smtpHost: row?.smtpHost ?? "smtp.gmail.com",
    smtpPort: row?.smtpPort ?? 465,
    verifiedAt: row?.verifiedAt ?? null,
    lastError: row?.lastError ?? null,
    encryptionAvailable: encryptionConfigured(),
  };
}

/**
 * The sender identity for a user, or null.
 *
 * Returns null — rather than falling back to the shared GMAIL_USER — when the
 * mailbox is missing, unverified, or its password will not decrypt. That
 * fallback is precisely the bug this whole phase exists to prevent: a
 * colleague's application leaving from somebody else's address, signed with
 * somebody else's name, to a real company.
 *
 * Callers treat null as "queue this for one-click sending instead".
 */
export async function getSenderIdentity(
  userId: number
): Promise<SenderIdentity | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.userMail)
    .where(eq(schema.userMail.userId, userId))
    .limit(1);
  if (!row) return null;

  // Unverified means "saved but never proved to work". A typo'd app password
  // looks identical to a correct one until something tries to send, and the
  // cost of finding out that way is an application that silently never arrives.
  if (!row.verifiedAt) return null;

  const password = await decryptSecret(row.smtpPasswordEncrypted);
  // Null here means a rotated or missing ENCRYPTION_KEY, or a tampered column.
  // Not recoverable, and not a reason to send as somebody else.
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

export type SaveMailResult = { ok: true } | { ok: false; error: string };

/**
 * Stores a mailbox. Always clears `verifiedAt` — changing any part of the
 * configuration invalidates whatever the previous verification proved.
 */
export async function saveMailSettings(opts: {
  userId: number;
  smtpUser: string;
  password: string;
  fromName?: string;
  smtpHost?: string;
  smtpPort?: number;
}): Promise<SaveMailResult> {
  if (!encryptionConfigured()) {
    return {
      ok: false,
      error:
        "ENCRYPTION_KEY is not set on this deployment, so mailbox passwords " +
        "cannot be stored securely. Ask an admin to set it.",
    };
  }
  const smtpUser = opts.smtpUser.trim().toLowerCase();
  if (!smtpUser.includes("@")) {
    return { ok: false, error: "That is not an email address." };
  }
  if (!opts.password) {
    return { ok: false, error: "An app password is required." };
  }

  const db = getDb();
  const values = {
    userId: opts.userId,
    smtpUser,
    smtpPasswordEncrypted: await encryptSecret(opts.password),
    fromName: opts.fromName?.trim() || null,
    smtpHost: opts.smtpHost?.trim() || "smtp.gmail.com",
    smtpPort: opts.smtpPort ?? 465,
    verifiedAt: null,
    lastError: null,
    updatedAt: new Date(),
  };

  await db
    .insert(schema.userMail)
    .values(values)
    .onConflictDoUpdate({ target: schema.userMail.userId, set: values });

  return { ok: true };
}

export async function markMailVerified(userId: number): Promise<void> {
  const db = getDb();
  await db
    .update(schema.userMail)
    .set({ verifiedAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(schema.userMail.userId, userId));
}

export async function markMailFailed(
  userId: number,
  error: string
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.userMail)
    .set({ verifiedAt: null, lastError: error, updatedAt: new Date() })
    .where(eq(schema.userMail.userId, userId));
}

export async function deleteMailSettings(userId: number): Promise<void> {
  const db = getDb();
  await db.delete(schema.userMail).where(eq(schema.userMail.userId, userId));
}

/**
 * The identity for a user, or the deployment-wide GMAIL_USER fallback.
 *
 * ONLY for the owner running the unattended pipeline, which predates accounts
 * and still sends from the single configured mailbox. Never call this on behalf
 * of a colleague — that is the exact mix-up getSenderIdentity() refuses to make.
 */
export async function getOwnerSenderIdentity(
  ownerId: number | null
): Promise<SenderIdentity | null> {
  if (ownerId !== null) {
    const own = await getSenderIdentity(ownerId);
    if (own) return own;
  }

  const user = process.env.GMAIL_USER;
  const password = process.env.GMAIL_APP_PASSWORD;
  if (!user || !password) return null;

  return {
    user,
    password,
    fromName: user,
    host: "smtp.gmail.com",
    port: 465,
  };
}
