import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { extractPdfText } from "@/lib/infra/pdf/text";
import { extractProfile } from "@/lib/domain/scoring/extract";

// ---------------------------------------------------------------------------
// The one test that actually exercises the PDF dependency.
//
// Everything else about extraction is tested against plain strings, which is
// the point of keeping lib/infra/pdf/text.ts as a thin edge. But "does unpdf
// parse a real file in this runtime" is exactly the question those tests cannot
// answer, and it is the one that breaks silently on a dependency bump.
//
// The fixture is a genuine single-page PDF with a real text stream and a valid
// xref table, not a stub.
// ---------------------------------------------------------------------------

const FIXTURE = resolve(__dirname, "../../fixtures/resume-backend.pdf");

describe("extractPdfText", () => {
  it("pulls readable text out of a real PDF", async () => {
    const result = await extractPdfText(readFileSync(FIXTURE));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.pages).toBe(1);
    expect(result.text.toLowerCase()).toContain("backend engineer");
    expect(result.text.toLowerCase()).toContain("kubernetes");
  });

  it("returns an error value rather than throwing on a non-PDF", async () => {
    // This runs on the resume-upload path. A file the parser dislikes must not
    // fail the upload -- storing the CV is the part that matters, because
    // applications attach it.
    const result = await extractPdfText(Buffer.from("this is not a pdf at all"));
    expect(result.ok).toBe(false);
  });

  it("returns an error value rather than throwing on an empty buffer", async () => {
    const result = await extractPdfText(Buffer.alloc(0));
    expect(result.ok).toBe(false);
  });

  it("feeds the extractor well enough to build a real profile", async () => {
    // The end-to-end path: bytes -> text -> profile. Pinning this together is
    // what catches a text extractor that technically succeeds but returns
    // whitespace or mojibake, which the pure tests would never notice.
    const text = await extractPdfText(readFileSync(FIXTURE));
    expect(text.ok).toBe(true);
    if (!text.ok) return;

    const { found } = extractProfile(text.text, new Date("2026-08-21T00:00:00Z"));
    expect(found.lowConfidence).toBe(false);
    expect(found.skills).toContain("go");
    expect(found.skills).toContain("kubernetes");
    expect(found.skills).toContain("kafka");
    expect(found.skills).not.toContain("flutter");
    expect(found.careerStart).toEqual(new Date(Date.UTC(2016, 5, 1)));
  });
});
