import { ImapFlow } from "imapflow";
import { getEnv } from "@/lib/config/env";

// ---------------------------------------------------------------------------
// Shared, STRICTLY READ-ONLY IMAP access to your own mailbox.
//
// Everything that reads mail in this system (LinkedIn job alerts, reply
// detection) goes through the same door so the connection lifecycle is written
// once: connect -> lock the mailbox -> do the work -> release -> logout, with
// the teardown in `finally` so a throw inside the callback can never leave a
// socket or a mailbox lock behind.
//
// READ-ONLY IS A HARD REQUIREMENT, not a default. The mailbox is opened with
// `{ readOnly: true }`, i.e. IMAP EXAMINE rather than SELECT, so the server
// does not set \Seen on the messages we fetch. This connector observes; it
// never marks mail as read, moves, flags or deletes anything. Nothing in this
// module may call messageFlagsSet/Add/Remove, messageMove, messageCopy,
// messageDelete or append.
//
// lib/infra/linkedin/alerts.ts still opens its own connection inline with the
// same settings and the same readOnly flag. `withMailbox` is shaped so it can
// drop in there unchanged - its body is already `for await (const msg of
// client.fetch(...))`, which is exactly the callback signature here.
// ---------------------------------------------------------------------------

export type ImapSettings = {
  host: string;
  port: number;
  mailbox: string;
  user: string;
  pass: string;
};

/**
 * Resolves IMAP settings from the validated env.
 *
 * IMAP_USER / IMAP_PASSWORD fall back to GMAIL_USER / GMAIL_APP_PASSWORD: the
 * app password already used for sending also authenticates IMAP, so a single
 * credential pair covers both directions.
 */
export function getImapSettings(): ImapSettings {
  const env = getEnv();
  const user = env.IMAP_USER ?? env.GMAIL_USER;
  const pass = env.IMAP_PASSWORD ?? env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      "No IMAP credentials. Set IMAP_USER/IMAP_PASSWORD, or " +
        "GMAIL_USER/GMAIL_APP_PASSWORD (the same app password works for IMAP)."
    );
  }
  return {
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    mailbox: env.IMAP_MAILBOX,
    user,
    pass,
  };
}

/**
 * Runs `fn` against a connected client with the configured mailbox open
 * read-only, and guarantees the lock is released and the connection closed -
 * whether `fn` returns, throws, or the mailbox never opened at all.
 *
 * The client is only valid for the duration of the callback: do not stash it,
 * and fully consume any `client.fetch()` iterator before returning.
 */
export async function withMailbox<T>(
  fn: (client: ImapFlow) => Promise<T>,
  opts: { mailbox?: string } = {}
): Promise<T> {
  const settings = getImapSettings();
  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: true,
    auth: { user: settings.user, pass: settings.pass },
    logger: false,
  });

  try {
    await client.connect();
  } catch (err) {
    // A failed handshake can still leave a half-open socket; drop it rather
    // than relying on the library's cleanup.
    client.close();
    throw err;
  }

  try {
    const lock = await client.getMailboxLock(opts.mailbox ?? settings.mailbox, {
      readOnly: true,
    });
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    // logout() is the polite close; if the server is already gone it rejects,
    // and close() then makes sure the socket is not left dangling either way.
    await client.logout().catch(() => undefined);
    client.close();
  }
}
