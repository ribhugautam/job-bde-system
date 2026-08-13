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
import { saveResume } from "../lib/documents";

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

  const result = await saveResume({
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
