import nodemailer from "nodemailer";
import { getEnv } from "@/lib/config/env";
import { normalizeMessageId } from "./message-id";
import type { SenderIdentity } from "@/lib/infra/db/user-mail";

// ---------------------------------------------------------------------------
// Outbound mail: SMTP via an app password.
//
// EVERY SEND NAMES ITS SENDER. This module used to read GMAIL_USER directly, so
// there was exactly one From address and one signature for the whole
// deployment. With colleagues on the system that is not a limitation, it is a
// correctness bug: their application would arrive from somebody else's address,
// signed as somebody else, at a real company. Callers now pass an identity, and
// there is no way to send without one.
//
// DRY_RUN is deliberately NOT consulted in here. The kill switch is enforced by
// the callers (see lib/pipeline/*), which decide per item whether to send or
// only draft, and which also suppress the digest. Adding a second check at this
// level would double-gate the same flag in two places and quietly change what
// "dry run" means depending on which layer you read. Behaviour is unchanged
// from before this file read env through getEnv().
// ---------------------------------------------------------------------------

/**
 * Transports are cached per sender address.
 *
 * Previously a single module-level transporter was memoised, which is exactly
 * wrong once there is more than one sender: the first person to send would have
 * pinned their credentials for the whole process, and everybody after them
 * would have sent as that person. Keyed by identity instead, so a cache hit can
 * only ever return the connection belonging to the same mailbox.
 */
const transporters = new Map<
  string,
  ReturnType<typeof nodemailer.createTransport>
>();

function transporterFor(identity: SenderIdentity) {
  const key = `${identity.host}:${identity.port}:${identity.user}`;
  const cached = transporters.get(key);
  if (cached) return cached;

  const transporter = nodemailer.createTransport({
    host: identity.host,
    port: identity.port,
    secure: identity.port === 465,
    auth: { user: identity.user, pass: identity.password },
  });
  transporters.set(key, transporter);
  return transporter;
}

/**
 * Opens a connection and authenticates WITHOUT sending anything.
 *
 * This is what "verified" means on a mailbox: a typo'd app password is
 * indistinguishable from a correct one until something actually authenticates,
 * and finding out at send time costs a real application to a real company.
 */
export async function verifyIdentity(
  identity: SenderIdentity
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await transporterFor(identity).verify();
    return { ok: true };
  } catch (err) {
    // A failed verification must not leave a poisoned connection cached for the
    // next attempt to reuse.
    transporters.delete(`${identity.host}:${identity.port}:${identity.user}`);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type MailAttachment = {
  filename: string;
  content: Buffer;
  contentType: string;
};

/**
 * Result of a send.
 *
 * `messageId` is the RFC 5322 Message-ID of the message that just left, in the
 * canonical form defined by lib/infra/mail/message-id.ts: bracket-less and
 * lower-cased. Store it verbatim - reply detection matches inbound In-Reply-To
 * / References headers against exactly this value.
 *
 * It is `""` in the rare case the transport reported no id. That is still
 * `ok: true` (the mail WAS accepted; reporting a failure would invite a retry
 * and a duplicate send), but the message is unanchored: replies to it can only
 * ever be found by the weaker sender fallback.
 */
export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

export async function sendMail(opts: {
  /** Whose mailbox this leaves from. Required — there is no default sender. */
  from: SenderIdentity;
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}): Promise<SendResult> {
  try {
    const transporter = transporterFor(opts.from);
    const info = await transporter.sendMail({
      // Display name plus address, so the recipient sees the person rather than
      // a bare mailbox.
      from: `"${opts.from.fromName.replace(/"/g, "")}" <${opts.from.user}>`,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    });

    const messageId = normalizeMessageId(info?.messageId);
    if (!messageId) {
      console.warn(
        `[mail] sent to ${opts.to} but the transport reported no Message-ID. ` +
          "Replies to this message cannot be matched by thread id."
      );
    }
    return { ok: true, messageId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Sends the daily digest to the deployment owner, never to a third party.
 *
 * Still deployment-wide rather than per-user: the digest reports on the shared
 * unattended pipeline, which runs one queue for everybody, so there is one
 * report and it goes to whoever operates it.
 */
export async function sendDigest(
  subject: string,
  body: string,
  from: SenderIdentity
): Promise<SendResult> {
  let owner: string | undefined;
  try {
    const env = getEnv();
    owner = env.OWNER_EMAIL || env.GMAIL_USER || from.user;
  } catch (err) {
    // getEnv() throws on a bad configuration anywhere in the schema. The digest
    // is best-effort reporting, so surface it as a result instead of taking the
    // caller down with it - same contract as before.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!owner) return { ok: false as const, error: "OWNER_EMAIL not set" };
  return sendMail({ from, to: owner, subject, text: body });
}
