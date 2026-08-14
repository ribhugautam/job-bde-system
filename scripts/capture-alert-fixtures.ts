// Saves one real job-alert email per source to tests/fixtures/alerts/ so the
// parsers in lib/infra/sources/email/ can be written against the template each
// service actually sends, rather than an assumed one.
//
// Read-only: the mailbox is opened with readOnly: true, so nothing is marked
// read and nothing is mutated. Run it once per source, commit the fixtures, and
// this script never needs to run again.
//
//   npx tsx scripts/capture-alert-fixtures.ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

// tsx does not load .env; Node 22's built-in loader does, with no dependency.
// Same approach as scripts/db-target.ts.
if (existsSync(".env")) process.loadEnvFile(".env");

const OUT_DIR = "tests/fixtures/alerts";

/**
 * `subjectMustMatch` exists because one sender can emit more than one kind of
 * mail. Wellfound sends both "New jobs: ..." digests and "An update from X, Y
 * and N others" company-activity mail; only the first carries job listings, and
 * capturing the wrong one would pin the wrong template.
 */
const TARGETS = [
  {
    file: "wellfound.html",
    fromDomain: "wellfound.com",
    subjectMustMatch: /^new jobs:/i,
  },
  {
    file: "indeed.html",
    fromDomain: "indeed.com",
    subjectMustMatch: /apply to jobs|@/i,
  },
] as const;

async function main() {
  const user = process.env.IMAP_USER ?? process.env.GMAIL_USER;
  const pass = process.env.IMAP_PASSWORD ?? process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error(
      "No IMAP credentials. Set IMAP_USER/IMAP_PASSWORD, or GMAIL_USER/GMAIL_APP_PASSWORD."
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
      const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      mkdirSync(OUT_DIR, { recursive: true });

      for (const target of TARGETS) {
        let saved = false;
        for await (const msg of client.fetch(
          { since, from: target.fromDomain },
          { source: true }
        )) {
          if (!msg.source) continue;
          const mail = await simpleParser(msg.source);
          const subject = mail.subject ?? "";
          if (!target.subjectMustMatch.test(subject)) continue;
          const html = typeof mail.html === "string" ? mail.html : undefined;
          if (!html) continue;

          const path = `${OUT_DIR}/${target.file}`;
          writeFileSync(path, html, "utf8");
          console.log(
            `saved ${path} (${html.length} bytes) subject: "${subject.slice(0, 70)}"`
          );
          saved = true;
          break;
        }
        if (!saved) {
          console.warn(
            `WARNING: no ${target.fromDomain} message in the last 60 days matched ${target.subjectMustMatch}`
          );
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
    client.close();
  }
}

main().catch((err) => {
  console.error("CAPTURE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
