// ---------------------------------------------------------------------------
// PDF -> text. The ONLY place a PDF library is touched.
//
// Isolated deliberately: everything that decides what a resume MEANS lives in
// lib/domain/scoring/extract.ts and takes a plain string, so it is testable
// against fixtures with no PDF, no binary, and no dependency. This file is the
// thin, boring edge.
//
// unpdf rather than pdf-parse: it ships a serverless build of pdf.js with no
// native bindings and no filesystem assumptions, which matters because this
// runs in a Vercel function where the filesystem is read-only apart from /tmp.
// ---------------------------------------------------------------------------

export type PdfTextResult =
  | { ok: true; text: string; pages: number }
  | { ok: false; error: string };

/**
 * Extracts text from a PDF buffer.
 *
 * NEVER THROWS. This runs on the resume-upload path, and a PDF that cannot be
 * parsed must not fail the upload: storing the file is the important part
 * (applications attach it), while extraction is a convenience that fills in a
 * profile the user can write by hand anyway. Losing the upload because the
 * parser disliked the file would be much the worse outcome.
 */
export async function extractPdfText(bytes: Buffer): Promise<PdfTextResult> {
  try {
    // Imported lazily so the PDF machinery is only pulled in when a resume is
    // actually uploaded, rather than on every cold start of every route.
    const { extractText, getDocumentProxy } = await import("unpdf");

    const doc = await getDocumentProxy(new Uint8Array(bytes));
    const { text, totalPages } = await extractText(doc, { mergePages: true });

    return {
      ok: true,
      text: typeof text === "string" ? text : String(text ?? ""),
      pages: totalPages,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
