import { simpleParser, type ParsedMail } from "mailparser";
import { getEnv } from "@/lib/config/env";
import { withMailbox } from "./imap";
import { normalizeMessageId } from "./message-id";

// ---------------------------------------------------------------------------
// Reply detection.
//
// When an application or a pitch goes out we store its Message-ID. This module
// reads inbound mail and decides which of those sent messages each inbound one
// is answering. A hit is what stops the follow-up sequence: get it wrong and
// the system keeps chasing someone who already replied, silently, because
// nothing about a missed match looks like an error.
//
// A match sets the thread to `responded` and CANCELS the rest of the follow-up
// sequence, so a false positive is not cosmetic: it stops the system chasing
// someone who never actually replied, which is the exact thing this feature
// exists to prevent. Machine-generated mail therefore has to be filtered out
// BEFORE matching - see `shouldIgnoreInbound`.
//
// The decision logic (`matchReplies`, `shouldIgnoreInbound`) is PURE functions
// over plain data. All IMAP lives in `fetchInboundSince`, which is deliberately
// thin, so the part that can actually be wrong is the part that is fully
// testable.
// ---------------------------------------------------------------------------

export { normalizeMessageId, toHeaderMessageId } from "./message-id";

/** Something we sent, and the anchor we can recognise its reply by. */
export type SentRef = {
  kind: "application" | "outreach";
  id: number;
  /** Message-ID as returned by sendMail(); any bracket/case form is accepted. */
  messageId: string;
  /** Recipient, bare or as a full "Name <a@b.com>" header. Enables the fallback. */
  sentTo?: string;
};

export type InboundMessage = {
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  from?: string;
  subject?: string;
  date?: Date;
  /**
   * Raw values of the headers listed in `IGNORE_SIGNAL_HEADERS`, keys
   * lower-cased. Consulted only by `shouldIgnoreInbound`, never by
   * `matchReplies`. PRESENCE of a key is meaningful on its own for some of
   * them, so an empty string value is not the same as a missing key.
   */
  headers?: Record<string, string>;
};

export type ReplyMatch = {
  ref: SentRef;
  inbound: InboundMessage;
  matchedBy: "in-reply-to" | "references" | "sender";
};

/**
 * Pulls the bare email address out of a From/To header value and lower-cases
 * it: `"Doe, Jane" <Jane@Example.com>` -> `jane@example.com`.
 *
 * Returns `""` when there is no address to be had - and `""` must never count
 * as a match.
 */
export function extractAddress(raw: string | null | undefined): string {
  if (!raw) return "";

  // An angle-bracket group wins over everything else, and the LAST one wins:
  // a display name can itself contain bracket-looking text.
  const angled = raw.match(/<([^<>]*)>/g);
  let candidate = angled?.length
    ? angled[angled.length - 1].slice(1, -1)
    : raw;

  // A bare header can still carry a list ("a@x, b@y") or a trailing comment, so
  // take the first token that actually looks like an address.
  candidate = candidate.split(/[\s,;]+/).find((t) => t.includes("@")) ?? "";

  const addr = candidate.replace(/^["'(<]+|[)">'.,;]+$/g, "").toLowerCase();
  return addr.includes("@") ? addr : "";
}

// ---------------------------------------------------------------------------
// Machine-generated mail
// ---------------------------------------------------------------------------

/**
 * The raw headers `shouldIgnoreInbound` consults, lower-cased.
 *
 * `fetchInboundSince` collects exactly this set, so the predicate and the fetch
 * cannot drift apart: add a signal here first, and the reader picks it up.
 */
export const IGNORE_SIGNAL_HEADERS = [
  "return-path",
  "content-type",
  "auto-submitted",
  "x-autoreply",
  "x-autorespond",
  "precedence",
] as const;

// Local parts that mean "an MTA wrote this", not "a person wrote this".
const BOUNCE_LOCAL_PARTS = new Set([
  "mailer-daemon",
  "postmaster",
  "bounce",
  "bounces",
]);

// Unattended mailboxes. Not bounces, but a reply can never come from one, so a
// message from here cannot be the human answer we are looking for either.
const UNATTENDED_LOCAL_PARTS = new Set([
  "no-reply",
  "noreply",
  "do-not-reply",
  "donotreply",
]);

/** Why a message was skipped. For logging - never branch on the exact string. */
export type IgnoreDecision = { ignore: boolean; reason?: string };

/**
 * Decides whether an inbound message is machine-generated and must never be
 * treated as a reply. Pure - the one piece of environment it needs, our own
 * sending address, is passed in.
 *
 * Three classes, checked in this order (first signal wins; the reason is only
 * for logging):
 *
 *   1. OUR OWN MAIL. `from` equals the configured sending address. With
 *      IMAP_MAILBOX=INBOX this is nearly moot, but point the mailbox at
 *      "[Gmail]/All Mail" and our own follow-ups - which quote the original id
 *      in References - would match as replies and mark EVERY thread answered,
 *      killing the whole sequence. A config change must not be able to do
 *      that, so this check is unconditional rather than mailbox-dependent.
 *
 *   2. BOUNCES / delivery reports. A DSN quotes our message in References, so
 *      a hard bounce otherwise reads as engagement: the applicant never
 *      received the mail and we would stop following up precisely when the
 *      send failed. Three independent signals, because each one alone is
 *      evadable - a null reverse-path (`Return-Path: <>`, the most reliable,
 *      as RFC 3464 requires it so bounces cannot bounce), a
 *      `multipart/report` content type (which also covers read receipts), and
 *      the sender's local part.
 *
 *   3. AUTO-REPLIES. An out-of-office is not an answer.
 *
 * Ambiguity resolves towards ignoring. The two failure directions are not
 * symmetric: wrongly ignoring a real reply means we send one more follow-up to
 * someone who answered - visible, recoverable, mildly awkward. Wrongly
 * accepting machine mail means we go silent on a live opportunity and nothing
 * ever surfaces it.
 */
export function shouldIgnoreInbound(
  message: InboundMessage,
  opts: { selfAddress?: string } = {}
): IgnoreDecision {
  const headers = new Map<string, string>();
  for (const [key, value] of Object.entries(message.headers ?? {})) {
    headers.set(key.trim().toLowerCase(), value ?? "");
  }

  const from = extractAddress(message.from);

  // --- 1. Our own mail ------------------------------------------------------
  const self = extractAddress(opts.selfAddress);
  if (self && from === self) return { ignore: true, reason: "self" };

  // --- 2. Bounces and delivery reports --------------------------------------
  // A present-but-empty Return-Path is the null reverse-path. Note the check is
  // on presence: a missing header says nothing, `<>` says "this is a bounce".
  if (headers.has("return-path") && !extractAddress(headers.get("return-path"))) {
    return { ignore: true, reason: "bounce:null-return-path" };
  }

  if ((headers.get("content-type") ?? "").toLowerCase().includes("multipart/report")) {
    return { ignore: true, reason: "bounce:report" };
  }

  // Exact local-part match, never a substring: "bounce-house@corp.com" is a
  // real company and "bouncer@corp.com" is a real person.
  const localPart = from.includes("@")
    ? from.slice(0, from.lastIndexOf("@"))
    : "";
  if (BOUNCE_LOCAL_PARTS.has(localPart)) {
    return { ignore: true, reason: "bounce:sender" };
  }
  if (UNATTENDED_LOCAL_PARTS.has(localPart)) {
    return { ignore: true, reason: "unattended:sender" };
  }

  // --- 3. Auto-replies ------------------------------------------------------
  // RFC 3834: "no" is the only value that means a human sent this. Anything
  // else - auto-replied, auto-generated, or a malformed empty value - is not a
  // reply.
  if (headers.has("auto-submitted")) {
    const value = (headers.get("auto-submitted") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (value !== "no") return { ignore: true, reason: "auto-reply:auto-submitted" };
  }

  // Non-standard but widespread; presence alone is the signal, whatever value
  // the vacation responder put in it.
  if (headers.has("x-autoreply")) {
    return { ignore: true, reason: "auto-reply:x-autoreply" };
  }
  if (headers.has("x-autorespond")) {
    return { ignore: true, reason: "auto-reply:x-autorespond" };
  }

  const precedence = (headers.get("precedence") ?? "").trim().toLowerCase();
  if (["auto_reply", "auto-reply", "auto_replied"].includes(precedence)) {
    return { ignore: true, reason: "auto-reply:precedence" };
  }

  return { ignore: false };
}

/**
 * Matches inbound messages against messages we sent.
 *
 * Rules, in strict priority order, evaluated per inbound message:
 *
 *   1. `inReplyTo` equals a stored Message-ID  -> "in-reply-to". The reply is
 *      pointing straight at our message; highest confidence there is.
 *   2. `references` contains a stored Message-ID -> "references". Catches a
 *      reply several messages deep in a thread, or a client that drops
 *      In-Reply-To. Scanned newest-first (References is oldest-first, so the
 *      last entry is the immediate parent and the most specific match).
 *   3. ONLY if neither id matched: `from` address equals a ref's `sentTo`
 *      -> "sender". Catches the recruiter who replies from a fresh compose
 *      window with no threading headers at all. Weakest signal, last resort.
 *
 * Guarantees:
 *   - One inbound message produces AT MOST one match, so it can never be
 *     counted as a reply to two different applications, and never twice for
 *     the same one.
 *   - An id match always beats a sender match, even when the sender match
 *     points at a different ref.
 *   - Output order follows `inbound` order; matches carry the original objects.
 *
 * Deliberately NOT guaranteed: a single ref can be matched by several inbound
 * messages (a thread with three replies is three matches). Callers that only
 * care whether a ref was answered at all should reduce by `ref.id`.
 *
 * When two refs collide on the same Message-ID or the same `sentTo` address -
 * e.g. two pitches to the same recruiter - the FIRST one in `sent` wins, so
 * pass the list in the order you want prioritised (most recent first is
 * usually what you want).
 *
 * Pure: no I/O, no clock, no env.
 *
 * It does NOT filter machine-generated mail - a bounce quoting our own id in
 * References matches here exactly like a human reply would, by design, because
 * that decision needs our own address and belongs one layer out. Any caller
 * feeding this from a source other than `fetchInboundSince` must run
 * `shouldIgnoreInbound` over the batch first.
 */
export function matchReplies(
  sent: SentRef[],
  inbound: InboundMessage[]
): ReplyMatch[] {
  if (!sent.length || !inbound.length) return [];

  const byMessageId = new Map<string, SentRef>();
  const bySentTo = new Map<string, SentRef>();
  for (const ref of sent) {
    const id = normalizeMessageId(ref.messageId);
    if (id && !byMessageId.has(id)) byMessageId.set(id, ref);
    const to = extractAddress(ref.sentTo);
    if (to && !bySentTo.has(to)) bySentTo.set(to, ref);
  }

  const out: ReplyMatch[] = [];

  for (const message of inbound) {
    // --- 1. In-Reply-To -----------------------------------------------------
    const inReplyTo = normalizeMessageId(message.inReplyTo);
    const direct = inReplyTo ? byMessageId.get(inReplyTo) : undefined;
    if (direct) {
      out.push({ ref: direct, inbound: message, matchedBy: "in-reply-to" });
      continue;
    }

    // --- 2. References ------------------------------------------------------
    const references = message.references ?? [];
    let threaded: SentRef | undefined;
    for (let i = references.length - 1; i >= 0; i--) {
      const id = normalizeMessageId(references[i]);
      const hit = id ? byMessageId.get(id) : undefined;
      if (hit) {
        threaded = hit;
        break;
      }
    }
    if (threaded) {
      out.push({ ref: threaded, inbound: message, matchedBy: "references" });
      continue;
    }

    // --- 3. Sender fallback -------------------------------------------------
    const from = extractAddress(message.from);
    const bySender = from ? bySentTo.get(from) : undefined;
    if (bySender) {
      out.push({ ref: bySender, inbound: message, matchedBy: "sender" });
    }
  }

  return out;
}

const SIGNAL_HEADER_SET = new Set<string>(IGNORE_SIGNAL_HEADERS);

/**
 * Picks the `IGNORE_SIGNAL_HEADERS` out of a parsed header block as raw
 * strings.
 *
 * `headerLines` rather than `parsed.headers`: the latter pre-parses structured
 * headers into objects, and what the predicate needs is the unmassaged text
 * plus honest presence information (an empty `X-Autoreply:` still counts).
 *
 * First occurrence wins on a repeated header. Return-Path is stamped by the
 * final delivery MTA at the top of the block, so the first one is the
 * authoritative one; concatenating a null `<>` with a later real address would
 * hide exactly the signal we are looking for.
 */
function collectSignalHeaders(
  parsed: ParsedMail | undefined
): Record<string, string> | undefined {
  const lines = parsed?.headerLines;
  if (!lines?.length) return undefined;

  const out: Record<string, string> = {};
  for (const { key, line } of lines) {
    const name = key.trim().toLowerCase();
    if (!SIGNAL_HEADER_SET.has(name) || name in out) continue;
    const colon = line.indexOf(":");
    out[name] = (colon >= 0 ? line.slice(colon + 1) : "")
      .replace(/\s+/g, " ")
      .trim();
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Reads inbound mail from the configured mailbox, read-only, maps it into
 * `InboundMessage`, and drops anything `shouldIgnoreInbound` rejects. No
 * matching happens here - that is `matchReplies`.
 *
 * Only headers are fetched, never message bodies: threading and the ignore
 * signals both live in the header block, and pulling full sources would drag
 * every attachment in the window down the wire for nothing. The fetch asks for
 * the complete block rather than a named list, so adding a signal to
 * `IGNORE_SIGNAL_HEADERS` needs no change here.
 *
 * NOTE on the window: IMAP SINCE has day granularity, so the server rounds
 * `since` down to midnight and may hand back messages slightly older than
 * asked. That is left alone rather than filtered - a wider window is harmless
 * for reply detection, whereas dropping messages with a missing or skewed Date
 * header would lose real replies.
 *
 * Header values are otherwise passed through as received; `matchReplies` owns
 * all normalisation so both sides of a comparison are canonicalised in one
 * place.
 */
export async function fetchInboundSince(since: Date): Promise<InboundMessage[]> {
  // Our own sending address, so a mailbox that happens to contain sent mail
  // cannot feed our own follow-ups back in as replies.
  const selfAddress = getEnv().GMAIL_USER;

  return withMailbox(async (client) => {
    const out: InboundMessage[] = [];

    for await (const msg of client.fetch({ since }, { envelope: true, headers: true })) {
      const parsed = msg.headers ? await simpleParser(msg.headers) : undefined;
      const envelope = msg.envelope;

      // mailparser gives References as a string when there is exactly one.
      const references = parsed?.references;

      const message: InboundMessage = {
        messageId: parsed?.messageId ?? envelope?.messageId,
        inReplyTo: parsed?.inReplyTo ?? envelope?.inReplyTo,
        references: Array.isArray(references)
          ? references
          : references
            ? [references]
            : undefined,
        from:
          parsed?.from?.value?.[0]?.address ??
          parsed?.from?.text ??
          envelope?.from?.[0]?.address,
        subject: parsed?.subject ?? envelope?.subject,
        date: parsed?.date ?? envelope?.date,
        headers: collectSignalHeaders(parsed),
      };

      if (shouldIgnoreInbound(message, { selfAddress }).ignore) continue;
      out.push(message);
    }

    return out;
  });
}
