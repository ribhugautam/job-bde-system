// scripts/capture-linkedin-fixture.ts
//
// Saves ONE real LinkedIn alert email to tests/fixtures/linkedin-alert.html so
// the parser in lib/infra/linkedin/alerts.ts can be written and tested against
// the template LinkedIn actually sends, rather than an assumed one.
//
// Read-only: the mailbox is opened with readOnly: true, so nothing is marked
// read and nothing is mutated. Run it once, commit the fixture, and this
// script never needs to run again.
//
//   npx tsx scripts/capture-linkedin-fixture.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// tsx does not load .env. Node 22's built-in loader does, with no dependency —
// this is the same approach scripts/db-target.ts takes, and for the same reason:
// a script that silently runs against the wrong configuration reports success
// while doing nothing useful.
if (existsSync(".env")) process.loadEnvFile(".env");

const OUT = "tests/fixtures/linkedin-alert.html";

async function main() {
  const user = process.env.IMAP_USER ?? process.env.GMAIL_USER;
  const pass = process.env.IMAP_PASSWORD ?? process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      "No IMAP credentials. Set IMAP_USER/IMAP_PASSWORD or GMAIL_USER/GMAIL_APP_PASSWORD."
    );
  }

  const client = new ImapFlow({
    host: process.env.IMAP_HOST ?? "imap.gmail.com",
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock(
      process.env.IMAP_MAILBOX ?? "INBOX",
      { readOnly: true }
    );
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      let saved = false;
      for await (const msg of client.fetch(
        { since, from: "linkedin.com" },
        { source: true }
      )) {
        if (!msg.source) continue;
        const mail = await simpleParser(msg.source);
        const html = typeof mail.html === "string" ? mail.html : undefined;
        // Alert digests are large and contain several /jobs/view/ links. A
        // one-link email is a different template (e.g. a single InMail).
        const links = html?.match(/jobs\/view\/\d+/g)?.length ?? 0;
        if (!html || links < 3) continue;
        mkdirSync("tests/fixtures", { recursive: true });
        writeFileSync(OUT, html, "utf8");
        console.log(
          `Saved ${OUT} (${html.length} bytes, ${links} job links, subject: ${mail.subject})`
        );
        saved = true;
        break;
      }
      if (!saved) {
        throw new Error(
          "No LinkedIn alert email with 3+ job links found in the last 30 days. " +
            "Check that job alerts are enabled and delivered to this mailbox."
        );
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("CAPTURE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
