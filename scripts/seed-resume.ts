/**
 * Load a resume PDF from disk into the database.
 *
 *   npm run seed:resume -- ./Ribhu_Gautam_CV.pdf
 *
 * Uses the same saveResume() path as the dashboard upload, so validation and
 * the "only one active resume" rule behave identically.
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { saveResume } from "../lib/infra/db/documents";
import { getOwnerUserId } from "../lib/infra/db/users";

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: npm run seed:resume -- <path-to-resume.pdf>");
    process.exit(1);
  }

  const path = resolve(arg);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    console.error(`Could not read ${path}: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // Seeds the OWNER's resume: this script predates accounts and exists to put
  // a CV on file from the command line before anyone has signed in.
  const ownerId = await getOwnerUserId();
  if (ownerId === null) {
    console.error(
      "No admin account exists yet. Run `npm run db:migrate` first -- it seeds " +
        "the first admin from OWNER_EMAIL and APP_PASSWORD."
    );
    process.exit(1);
  }

  const result = await saveResume({
    userId: ownerId,
    filename: basename(path),
    mimeType: "application/pdf",
    bytes,
  });

  if (!result.ok) {
    console.error(`Rejected: ${result.error}`);
    process.exit(1);
  }
  console.log(
    `Stored ${basename(path)} (${(result.sizeBytes / 1024).toFixed(0)} KB) as document #${result.id}. It is now the active resume.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
