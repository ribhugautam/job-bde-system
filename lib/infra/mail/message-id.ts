// ---------------------------------------------------------------------------
// Message-ID normalisation.
//
// The RFC 5322 Message-ID of an email we sent is the anchor for the whole
// reply-detection design: we store it when the application/pitch goes out, and
// later look for it in the In-Reply-To / References headers of inbound mail.
// Every comparison in the system runs through this module so both sides are
// canonicalised identically.
//
// CANONICAL FORM (the one decision everything downstream depends on):
//
//     no angle brackets, no whitespace, lower-cased
//
//     "  <ABC.123@Example.COM> "   ->   "abc.123@example.com"
//
// Why bracket-less: a Message-ID appears WITH brackets in the raw header and
// nodemailer reports it with brackets, but plenty of clients, parsers and
// databases hand it back without them. Storing the bracket-less form means the
// value in the database is already the comparison form, so a naive
// `WHERE message_id = ?` elsewhere still lines up. Use `toHeaderMessageId()`
// when you need to put one back into an outbound In-Reply-To / References
// header.
//
// Why fully lower-cased: strictly, RFC 5322 makes only the domain half
// case-insensitive (it is a hostname) while the local half is an opaque token.
// We fold both anyway, deliberately:
//
//   - A missed match fails INVISIBLY. Follow-ups keep firing at someone who
//     already replied, and nothing in the system looks broken.
//   - A false match needs two of our OWN sent ids that differ only in case.
//     nodemailer generates `<lowercase-hex-uuid@domain>`, so that cannot
//     happen with ids this system produces.
//
// The asymmetry of those two failure modes is the entire argument: aggressive
// folding costs nothing here and protects against real-world relays and
// clients that rewrite header case.
// ---------------------------------------------------------------------------

/**
 * Canonicalises a Message-ID for comparison and storage.
 *
 * Accepts a raw header value with or without angle brackets, with surrounding
 * or embedded whitespace (long headers get folded across lines), in any case.
 * Returns `""` for anything unusable - and an empty id must never be treated
 * as a match, so callers guard on it rather than comparing blindly.
 */
export function normalizeMessageId(raw: string | null | undefined): string {
  if (!raw) return "";

  // Header folding can insert CRLF + space inside a long id, so strip every
  // whitespace character rather than just trimming the ends.
  let id = raw.replace(/\s+/g, "");

  // Peel angle brackets off both ends. A loop rather than a single strip: some
  // clients emit "<<id>>" when re-wrapping a value that was already bracketed.
  while (id.startsWith("<")) id = id.slice(1);
  while (id.endsWith(">")) id = id.slice(0, -1);

  return id.toLowerCase();
}

/**
 * The inverse: the bracketed form that belongs in an outbound In-Reply-To or
 * References header, so a follow-up threads under the original message in the
 * recipient's client. Returns `""` when there is no usable id.
 */
export function toHeaderMessageId(raw: string | null | undefined): string {
  const id = normalizeMessageId(raw);
  return id ? `<${id}>` : "";
}
