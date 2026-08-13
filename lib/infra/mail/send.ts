import nodemailer from "nodemailer";
import { getEnv } from "@/lib/config/env";
import { normalizeMessageId } from "./message-id";

// ---------------------------------------------------------------------------
// Outbound mail: Gmail SMTP via an app password.
//
// DRY_RUN is deliberately NOT consulted in here. The kill switch is enforced by
// the callers (see lib/pipeline/*), which decide per item whether to send or
// only draft, and which also suppress the digest. Adding a second check at this
// level would double-gate the same flag in two places and quietly change what
// "dry run" means depending on which layer you read. Behaviour is unchanged
// from before this file read env through getEnv().
// ---------------------------------------------------------------------------

let _transporter: ReturnType<typeof nodemailer.createTransport> | null = null;

function getTransporter() {
  if (_transporter) return _transporter;
  const { GMAIL_USER: user, GMAIL_APP_PASSWORD: pass } = getEnv();
  if (!user || !pass) {
    throw new Error(
      "GMAIL_USER / GMAIL_APP_PASSWORD are not set. Enable 2FA on the Gmail " +
        "account you want to send from, generate an App Password " +
        "(https://myaccount.google.com/apppasswords), and add both as env " +
        "vars in Vercel."
    );
  }
  _transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
  return _transporter;
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
  to: string;
  subject: string;
  text: string;
  attachments?: MailAttachment[];
}): Promise<SendResult> {
  try {
    const transporter = getTransporter();
    const info = await transporter.sendMail({
      from: getEnv().GMAIL_USER,
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

// Sends the daily digest to the owner (Ribhu), never to a third party.
export async function sendDigest(
  subject: string,
  body: string
): Promise<SendResult> {
  let owner: string | undefined;
  try {
    const env = getEnv();
    owner = env.OWNER_EMAIL || env.GMAIL_USER;
  } catch (err) {
    // getEnv() throws on a bad configuration anywhere in the schema. The digest
    // is best-effort reporting, so surface it as a result instead of taking the
    // caller down with it - same contract as before.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!owner) return { ok: false as const, error: "OWNER_EMAIL not set" };
  return sendMail({ to: owner, subject, text: body });
}
