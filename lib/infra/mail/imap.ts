import { ImapFlow } from "imapflow";
import { getEnv } from "@/lib/config/env";
import type { Settings } from "@/lib/config/settings";

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
// `withMailbox` is the shared door: LinkedIn, Wellfound and Indeed alert
// ingestion (lib/infra/linkedin/alerts.ts and lib/infra/mail/alert-ingest.ts)
// and reply detection (lib/infra/mail/replies.ts) all connect through it
// rather than opening a client of their own.
// ---------------------------------------------------------------------------

export type ImapSettings = {
  host: string;
  port: number;
  mailbox: string;
  user: string;
  pass: string;
};

/**
 * Resolves IMAP connection details.
 *
 * Split across both config layers, deliberately: host, port and mailbox are
 * harmless and live in runtime settings, while the credentials stay in env.
 * Passing the settings in rather than reading them keeps this synchronous and
 * keeps the caller in charge of when the settings row is read.
 *
 * IMAP_USER / IMAP_PASSWORD fall back to GMAIL_USER / GMAIL_APP_PASSWORD: the
 * app password already used for sending also authenticates IMAP, so a single
 * credential pair covers both directions.
 */
export function getImapSettings(settings: Settings): ImapSettings {
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
    host: settings.IMAP_HOST,
    port: settings.IMAP_PORT,
    mailbox: settings.IMAP_MAILBOX,
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
  // Settings first, so every caller is forced to say which configuration it is
  // connecting under rather than reaching for an ambient one.
  settings: Settings,
  fn: (client: ImapFlow) => Promise<T>,
  opts: { mailbox?: string } = {}
): Promise<T> {
  const imap = getImapSettings(settings);
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: true,
    auth: { user: imap.user, pass: imap.pass },
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
    const lock = await client.getMailboxLock(opts.mailbox ?? imap.mailbox, {
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
