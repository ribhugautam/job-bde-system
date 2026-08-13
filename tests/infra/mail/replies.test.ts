import { describe, expect, it } from "vitest";
import {
  extractAddress,
  matchReplies,
  normalizeMessageId,
  shouldIgnoreInbound,
  toHeaderMessageId,
  type InboundMessage,
  type SentRef,
} from "@/lib/infra/mail/replies";

// ---------------------------------------------------------------------------
// Reply detection is the thing that stops follow-ups. A missed match does not
// throw, does not log and does not show up anywhere - it just keeps chasing
// someone who already answered. So these tests lean hard on the boring stuff:
// bracket forms, header case, whitespace, and the priority order between the
// three rules.
// ---------------------------------------------------------------------------

const application = (
  id: number,
  messageId: string,
  sentTo?: string
): SentRef => ({ kind: "application", id, messageId, sentTo });

const outreach = (id: number, messageId: string, sentTo?: string): SentRef => ({
  kind: "outreach",
  id,
  messageId,
  sentTo,
});

describe("normalizeMessageId", () => {
  it("strips angle brackets", () => {
    expect(normalizeMessageId("<abc@example.com>")).toBe("abc@example.com");
    expect(normalizeMessageId("abc@example.com")).toBe("abc@example.com");
  });

  it("strips surrounding and folded-in whitespace", () => {
    expect(normalizeMessageId("   <abc@example.com>  ")).toBe("abc@example.com");
    expect(normalizeMessageId("< abc@example.com >")).toBe("abc@example.com");
    // A long header folded across lines by the sending client.
    expect(normalizeMessageId("<abc.long.id\r\n @example.com>")).toBe(
      "abc.long.id@example.com"
    );
  });

  it("folds case so a rewritten header still matches", () => {
    expect(normalizeMessageId("<ABC@Example.COM>")).toBe("abc@example.com");
    expect(normalizeMessageId("ABC@EXAMPLE.COM")).toBe("abc@example.com");
  });

  it("peels doubled brackets", () => {
    expect(normalizeMessageId("<<abc@example.com>>")).toBe("abc@example.com");
  });

  it("returns empty for anything unusable", () => {
    expect(normalizeMessageId(undefined)).toBe("");
    expect(normalizeMessageId(null)).toBe("");
    expect(normalizeMessageId("")).toBe("");
    expect(normalizeMessageId("   ")).toBe("");
    expect(normalizeMessageId("<>")).toBe("");
  });

  it("leaves an id with no domain alone apart from folding", () => {
    expect(normalizeMessageId("<Opaque-ID-123>")).toBe("opaque-id-123");
  });

  it("is idempotent", () => {
    const once = normalizeMessageId("  <ABC@Example.COM> ");
    expect(normalizeMessageId(once)).toBe(once);
  });

  it("round-trips back into a header value", () => {
    expect(toHeaderMessageId("  ABC@Example.COM ")).toBe("<abc@example.com>");
    expect(toHeaderMessageId(undefined)).toBe("");
  });
});

describe("extractAddress", () => {
  it("pulls the bare address out of a display-name header", () => {
    expect(extractAddress("Jane Doe <Jane@Example.com>")).toBe(
      "jane@example.com"
    );
    expect(extractAddress('"Doe, Jane" <jane@example.com>')).toBe(
      "jane@example.com"
    );
    expect(extractAddress("<jane@example.com>")).toBe("jane@example.com");
    expect(extractAddress("  Jane@Example.com  ")).toBe("jane@example.com");
  });

  it("takes the first address from a bare list", () => {
    expect(extractAddress("jane@example.com, bob@other.com")).toBe(
      "jane@example.com"
    );
  });

  it("returns empty when there is no address", () => {
    expect(extractAddress(undefined)).toBe("");
    expect(extractAddress("")).toBe("");
    expect(extractAddress("Jane Doe")).toBe("");
    expect(extractAddress("<>")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// A match cancels the remaining follow-up sequence, so every one of these
// filters is protecting against the same failure: the system going quiet on a
// live opportunity because a machine sent us something.
// ---------------------------------------------------------------------------

const SELF = { selfAddress: "me@mydomain.com" };

/** A perfectly ordinary human reply. Nothing here may ever be filtered. */
const humanReply = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  messageId: "<reply@corp.com>",
  inReplyTo: "<sent-1@mail.example.com>",
  references: ["<sent-1@mail.example.com>"],
  from: "Jane Doe <jane@corp.com>",
  subject: "Re: Application: Senior Engineer",
  date: new Date("2026-08-13T10:00:00Z"),
  headers: {
    "return-path": "<jane@corp.com>",
    "content-type": 'multipart/alternative; boundary="000000"',
  },
  ...over,
});

describe("shouldIgnoreInbound - a real reply survives every filter", () => {
  it("keeps an ordinary human reply", () => {
    expect(shouldIgnoreInbound(humanReply(), SELF)).toEqual({ ignore: false });
  });

  it("keeps a reply that merely talks about bounces", () => {
    const msg = humanReply({
      subject: "Re: your email bounced - resending",
      headers: {
        "return-path": "<jane@corp.com>",
        "content-type": "text/plain",
      },
    });
    expect(shouldIgnoreInbound(msg, SELF).ignore).toBe(false);
  });

  it("keeps senders whose address merely contains a filtered word", () => {
    const addresses = [
      "bounce-house@corp.com",
      "bouncer@corp.com",
      "jane.noreply-fan@corp.com",
      "postmaster.jane@corp.com",
      // The DOMAIN contains "bounces"; the person is not a daemon.
      "jane@bounces.corp.com",
    ];
    for (const from of addresses) {
      expect(shouldIgnoreInbound(humanReply({ from }), SELF)).toEqual({
        ignore: false,
      });
    }
  });

  it("keeps a message with no headers at all", () => {
    expect(shouldIgnoreInbound({}, SELF)).toEqual({ ignore: false });
    expect(shouldIgnoreInbound({ from: "jane@corp.com", headers: {} }, SELF)).toEqual({
      ignore: false,
    });
  });
});

describe("shouldIgnoreInbound - our own mail", () => {
  it("drops a message sent from the configured sending address", () => {
    const msg = humanReply({ from: "me@mydomain.com" });
    expect(shouldIgnoreInbound(msg, SELF)).toEqual({ ignore: true, reason: "self" });
  });

  it("drops it regardless of display name or case", () => {
    const msg = humanReply({ from: "Job Bot <ME@MyDomain.com>" });
    expect(shouldIgnoreInbound(msg, SELF).ignore).toBe(true);
  });

  it("keeps mail from anyone else", () => {
    expect(shouldIgnoreInbound(humanReply(), SELF).ignore).toBe(false);
  });

  it("does not treat a missing From as a self-match", () => {
    expect(shouldIgnoreInbound({ from: undefined }, SELF).ignore).toBe(false);
    expect(shouldIgnoreInbound({ from: "" }, SELF).ignore).toBe(false);
  });

  it("does nothing when no self address is configured", () => {
    expect(shouldIgnoreInbound(humanReply({ from: "me@mydomain.com" }))).toEqual({
      ignore: false,
    });
  });
});

describe("shouldIgnoreInbound - bounces", () => {
  it("drops a null reverse-path", () => {
    const msg = humanReply({
      from: "Mail Delivery Subsystem <md@relay.corp.com>",
      headers: { "return-path": "<>" },
    });
    expect(shouldIgnoreInbound(msg, SELF)).toEqual({
      ignore: true,
      reason: "bounce:null-return-path",
    });
  });

  it("treats a present-but-empty Return-Path as null", () => {
    const msg = humanReply({ headers: { "return-path": "" } });
    expect(shouldIgnoreInbound(msg, SELF).ignore).toBe(true);
  });

  it("keeps a real Return-Path", () => {
    const msg = humanReply({ headers: { "return-path": "<jane@corp.com>" } });
    expect(shouldIgnoreInbound(msg, SELF).ignore).toBe(false);
  });

  it("drops a multipart/report delivery status notification", () => {
    const msg = humanReply({
      from: "Some Relay <relay@corp.com>",
      headers: {
        "content-type":
          'multipart/report; report-type=delivery-status; boundary="xyz"',
      },
    });
    expect(shouldIgnoreInbound(msg, SELF)).toEqual({
      ignore: true,
      reason: "bounce:report",
    });
  });

  it("matches the content type case-insensitively", () => {
    const msg = humanReply({
      headers: { "content-type": "Multipart/Report; report-type=Delivery-Status" },
    });
    expect(shouldIgnoreInbound(msg, SELF).ignore).toBe(true);
  });

  it("keeps ordinary multipart mail", () => {
    const msg = humanReply({
      headers: { "content-type": "multipart/alternative; boundary=abc" },
    });
    expect(shouldIgnoreInbound(msg, SELF).ignore).toBe(false);
  });

  it("drops daemon senders by exact local part, in any case", () => {
    const senders = [
      "mailer-daemon@googlemail.com",
      "MAILER-DAEMON@corp.com",
      "postmaster@corp.com",
      "bounce@corp.com",
      "Bounces <bounces@corp.com>",
    ];
    for (const from of senders) {
      expect(shouldIgnoreInbound(humanReply({ from }), SELF)).toEqual({
        ignore: true,
        reason: "bounce:sender",
      });
    }
  });

  it("drops unattended mailboxes", () => {
    for (const from of [
      "no-reply@corp.com",
      "noreply@corp.com",
      "donotreply@corp.com",
      "do-not-reply@corp.com",
    ]) {
      expect(shouldIgnoreInbound(humanReply({ from }), SELF)).toEqual({
        ignore: true,
        reason: "unattended:sender",
      });
    }
  });
});

describe("shouldIgnoreInbound - auto-replies", () => {
  const withHeaders = (headers: Record<string, string>) =>
    shouldIgnoreInbound(humanReply({ headers }), SELF);

  it("drops Auto-Submitted with any value other than no", () => {
    expect(withHeaders({ "auto-submitted": "auto-replied" })).toEqual({
      ignore: true,
      reason: "auto-reply:auto-submitted",
    });
    expect(withHeaders({ "auto-submitted": "auto-generated" }).ignore).toBe(true);
    expect(
      withHeaders({ "auto-submitted": "auto-replied; owner-email=hr@corp.com" })
        .ignore
    ).toBe(true);
    // Malformed empty value: ambiguity resolves towards ignoring.
    expect(withHeaders({ "auto-submitted": "" }).ignore).toBe(true);
  });

  it("keeps Auto-Submitted: no, which is what human mail carries", () => {
    expect(withHeaders({ "auto-submitted": "no" }).ignore).toBe(false);
    expect(withHeaders({ "auto-submitted": " No " }).ignore).toBe(false);
  });

  it("drops X-Autoreply and X-Autorespond on presence alone", () => {
    expect(withHeaders({ "x-autoreply": "" })).toEqual({
      ignore: true,
      reason: "auto-reply:x-autoreply",
    });
    expect(withHeaders({ "x-autoreply": "yes" }).ignore).toBe(true);
    expect(withHeaders({ "x-autorespond": "vacation" })).toEqual({
      ignore: true,
      reason: "auto-reply:x-autorespond",
    });
  });

  it("drops Precedence: auto_reply", () => {
    expect(withHeaders({ precedence: "auto_reply" })).toEqual({
      ignore: true,
      reason: "auto-reply:precedence",
    });
    expect(withHeaders({ precedence: "Auto-Reply" }).ignore).toBe(true);
  });

  it("keeps Precedence: bulk - an ATS acknowledgement is still contact", () => {
    expect(withHeaders({ precedence: "bulk" }).ignore).toBe(false);
  });

  it("reads header names case-insensitively", () => {
    const msg = humanReply({ headers: { "Auto-Submitted": "auto-replied" } });
    expect(shouldIgnoreInbound(msg, SELF).ignore).toBe(true);
  });
});

describe("shouldIgnoreInbound - what it is protecting", () => {
  // These two show the actual production failure: matchReplies happily matches
  // machine mail, because a bounce and a follow-up both quote our own id. The
  // predicate is the only thing standing between that and a cancelled sequence.
  const ref = application(1, "<sent-1@mail.example.com>", "jane@corp.com");

  it("a hard bounce WOULD match, and is filtered before it can", () => {
    const bounce: InboundMessage = {
      messageId: "<dsn@relay.corp.com>",
      references: ["<sent-1@mail.example.com>"],
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      subject: "Delivery Status Notification (Failure)",
      headers: {
        "return-path": "<>",
        "content-type": "multipart/report; report-type=delivery-status",
      },
    };

    expect(matchReplies([ref], [bounce])).toHaveLength(1);
    expect(shouldIgnoreInbound(bounce, SELF).ignore).toBe(true);
    expect(
      matchReplies([ref], [bounce].filter((m) => !shouldIgnoreInbound(m, SELF).ignore))
    ).toEqual([]);
  });

  it("our own follow-up in an All Mail style mailbox WOULD match, and is filtered", () => {
    const ourFollowUp: InboundMessage = {
      messageId: "<followup-1@mydomain.com>",
      references: ["<sent-1@mail.example.com>"],
      from: "Ribhu <me@mydomain.com>",
      subject: "Re: Application: Senior Engineer",
    };

    expect(matchReplies([ref], [ourFollowUp])).toHaveLength(1);
    expect(shouldIgnoreInbound(ourFollowUp, SELF)).toEqual({
      ignore: true,
      reason: "self",
    });
  });

  it("an out-of-office WOULD match by sender, and is filtered", () => {
    const ooo: InboundMessage = {
      messageId: "<ooo@corp.com>",
      from: "Jane Doe <jane@corp.com>",
      subject: "Automatic reply: Application: Senior Engineer",
      headers: { "auto-submitted": "auto-replied" },
    };

    expect(matchReplies([ref], [ooo])).toHaveLength(1);
    expect(shouldIgnoreInbound(ooo, SELF).ignore).toBe(true);
  });
});

describe("matchReplies - empty inputs", () => {
  it("returns [] for every empty combination", () => {
    const ref = application(1, "<a@x.com>", "jane@example.com");
    const msg: InboundMessage = { inReplyTo: "<a@x.com>" };
    expect(matchReplies([], [])).toEqual([]);
    expect(matchReplies([], [msg])).toEqual([]);
    expect(matchReplies([ref], [])).toEqual([]);
  });
});

describe("matchReplies - rule 1, In-Reply-To", () => {
  it("matches an exact In-Reply-To and carries the original objects", () => {
    const ref = application(7, "<sent-1@mail.example.com>");
    const msg: InboundMessage = {
      messageId: "<reply-1@corp.com>",
      inReplyTo: "<sent-1@mail.example.com>",
      from: "Recruiter <hr@corp.com>",
    };

    const matches = matchReplies([ref], [msg]);

    expect(matches).toHaveLength(1);
    expect(matches[0].matchedBy).toBe("in-reply-to");
    expect(matches[0].ref).toBe(ref);
    expect(matches[0].inbound).toBe(msg);
  });

  it("matches across bracket, whitespace and case variance", () => {
    const ref = application(1, "<ABC@Example.COM>");
    const variants: InboundMessage[] = [
      { inReplyTo: "abc@example.com" },
      { inReplyTo: "<abc@example.com>" },
      { inReplyTo: "  <ABC@EXAMPLE.COM>  " },
      { inReplyTo: "< abc@Example.com >" },
    ];

    const matches = matchReplies([ref], variants);

    expect(matches).toHaveLength(4);
    expect(matches.every((m) => m.matchedBy === "in-reply-to")).toBe(true);
    expect(matches.every((m) => m.ref === ref)).toBe(true);
  });

  it("matches when the STORED id is the messy one", () => {
    const ref = application(1, "  <ABC@Example.COM>\r\n ");
    const matches = matchReplies([ref], [{ inReplyTo: "abc@example.com" }]);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedBy).toBe("in-reply-to");
  });
});

describe("matchReplies - rule 2, References", () => {
  it("matches when In-Reply-To is absent", () => {
    const ref = application(3, "<sent-3@mail.example.com>");
    const msg: InboundMessage = {
      references: ["<sent-3@mail.example.com>"],
    };

    const matches = matchReplies([ref], [msg]);

    expect(matches).toHaveLength(1);
    expect(matches[0].matchedBy).toBe("references");
    expect(matches[0].ref).toBe(ref);
  });

  it("matches when In-Reply-To points at something we never sent", () => {
    const ref = application(3, "<sent-3@mail.example.com>");
    const msg: InboundMessage = {
      inReplyTo: "<someone-elses-message@third-party.com>",
      references: ["<sent-3@mail.example.com>", "<someone-elses-message@third-party.com>"],
    };

    const matches = matchReplies([ref], [msg]);

    expect(matches).toHaveLength(1);
    expect(matches[0].matchedBy).toBe("references");
    expect(matches[0].ref).toBe(ref);
  });

  it("finds our id several messages deep in a thread", () => {
    const ref = application(4, "<sent-4@mail.example.com>");
    const msg: InboundMessage = {
      inReplyTo: "<hop-3@corp.com>",
      references: [
        "<sent-4@mail.example.com>",
        "<hop-1@corp.com>",
        "<hop-2@corp.com>",
        "<hop-3@corp.com>",
      ],
    };

    const matches = matchReplies([ref], [msg]);

    expect(matches).toHaveLength(1);
    expect(matches[0].matchedBy).toBe("references");
  });

  it("normalises References entries too", () => {
    const ref = application(5, "abc@example.com");
    const msg: InboundMessage = { references: ["  <ABC@Example.COM> "] };

    const matches = matchReplies([ref], [msg]);

    expect(matches).toHaveLength(1);
    expect(matches[0].matchedBy).toBe("references");
  });

  it("prefers the nearest ancestor when References names two of our messages", () => {
    const older = application(1, "<older@mail.example.com>");
    const newer = application(2, "<newer@mail.example.com>");
    const msg: InboundMessage = {
      // References is oldest-first: the last entry is the immediate parent.
      references: ["<older@mail.example.com>", "<newer@mail.example.com>"],
    };

    const matches = matchReplies([older, newer], [msg]);

    expect(matches).toHaveLength(1);
    expect(matches[0].ref).toBe(newer);
  });
});

describe("matchReplies - rule 3, sender fallback", () => {
  it("fires when there are no threading headers at all", () => {
    const ref = outreach(9, "<sent-9@mail.example.com>", "Jane Doe <Jane@Corp.com>");
    const msg: InboundMessage = {
      messageId: "<fresh-compose@corp.com>",
      from: '"Doe, Jane" <jane@corp.com>',
      subject: "Re: your note",
    };

    const matches = matchReplies([ref], [msg]);

    expect(matches).toHaveLength(1);
    expect(matches[0].matchedBy).toBe("sender");
    expect(matches[0].ref).toBe(ref);
  });

  it("compares only the bare address, case-insensitively", () => {
    const ref = outreach(9, "<sent-9@mail.example.com>", "jane@corp.com");
    const matches = matchReplies([ref], [{ from: "Jane Doe <JANE@CORP.COM>" }]);
    expect(matches).toHaveLength(1);
    expect(matches[0].matchedBy).toBe("sender");
  });

  it("never fires for a ref with no sentTo", () => {
    const ref = application(1, "<sent-1@mail.example.com>");
    expect(matchReplies([ref], [{ from: "jane@corp.com" }])).toEqual([]);
  });

  it("does not fire when the ids already matched", () => {
    const ref = application(1, "<sent-1@mail.example.com>", "jane@corp.com");
    const msg: InboundMessage = {
      inReplyTo: "<sent-1@mail.example.com>",
      from: "jane@corp.com",
    };

    const matches = matchReplies([ref], [msg]);

    expect(matches).toHaveLength(1);
    expect(matches[0].matchedBy).toBe("in-reply-to");
  });
});

describe("matchReplies - priority order", () => {
  it("an In-Reply-To match beats a sender match on a DIFFERENT ref", () => {
    const idRef = application(1, "<sent-1@mail.example.com>", "someone@else.com");
    const senderRef = outreach(2, "<sent-2@mail.example.com>", "jane@corp.com");
    const msg: InboundMessage = {
      inReplyTo: "<sent-1@mail.example.com>",
      from: "Jane <jane@corp.com>",
    };

    const matches = matchReplies([idRef, senderRef], [msg]);

    expect(matches).toHaveLength(1);
    expect(matches[0].ref).toBe(idRef);
    expect(matches[0].matchedBy).toBe("in-reply-to");
  });

  it("a References match beats a sender match on a DIFFERENT ref", () => {
    const idRef = application(1, "<sent-1@mail.example.com>", "someone@else.com");
    const senderRef = outreach(2, "<sent-2@mail.example.com>", "jane@corp.com");
    const msg: InboundMessage = {
      references: ["<sent-1@mail.example.com>"],
      from: "Jane <jane@corp.com>",
    };

    const matches = matchReplies([idRef, senderRef], [msg]);

    expect(matches).toHaveLength(1);
    expect(matches[0].ref).toBe(idRef);
    expect(matches[0].matchedBy).toBe("references");
  });

  it("In-Reply-To beats References when they name different refs", () => {
    const irtRef = application(1, "<sent-1@mail.example.com>");
    const refsRef = application(2, "<sent-2@mail.example.com>");
    const msg: InboundMessage = {
      inReplyTo: "<sent-1@mail.example.com>",
      references: ["<sent-2@mail.example.com>"],
    };

    const matches = matchReplies([irtRef, refsRef], [msg]);

    expect(matches).toHaveLength(1);
    expect(matches[0].ref).toBe(irtRef);
    expect(matches[0].matchedBy).toBe("in-reply-to");
  });
});

describe("matchReplies - at most one match per inbound message", () => {
  it("does not match one inbound message to two refs", () => {
    const a = application(1, "<sent-1@mail.example.com>", "jane@corp.com");
    const b = outreach(2, "<sent-2@mail.example.com>", "jane@corp.com");
    const msg: InboundMessage = {
      references: ["<sent-1@mail.example.com>", "<sent-2@mail.example.com>"],
      from: "jane@corp.com",
    };

    const matches = matchReplies([a, b], [msg]);

    expect(matches).toHaveLength(1);
  });

  it("does not match the same ref twice via In-Reply-To and References", () => {
    const ref = application(1, "<sent-1@mail.example.com>");
    const msg: InboundMessage = {
      inReplyTo: "<sent-1@mail.example.com>",
      references: ["<sent-1@mail.example.com>"],
    };

    expect(matchReplies([ref], [msg])).toHaveLength(1);
  });

  it("picks the first ref listed when two share a sentTo", () => {
    const first = outreach(1, "<sent-1@mail.example.com>", "jane@corp.com");
    const second = outreach(2, "<sent-2@mail.example.com>", "jane@corp.com");

    const matches = matchReplies([first, second], [{ from: "jane@corp.com" }]);

    expect(matches).toHaveLength(1);
    expect(matches[0].ref).toBe(first);
  });
});

describe("matchReplies - no false positives", () => {
  it("ignores unrelated inbound mail", () => {
    const ref = application(1, "<sent-1@mail.example.com>", "jane@corp.com");
    const noise: InboundMessage[] = [
      {
        messageId: "<newsletter@marketing.com>",
        from: "news@marketing.com",
        subject: "Weekly roundup",
      },
      {
        inReplyTo: "<not-ours@elsewhere.com>",
        references: ["<also-not-ours@elsewhere.com>"],
        from: "bob@elsewhere.com",
      },
      {},
    ];

    expect(matchReplies([ref], noise)).toEqual([]);
  });

  it("never matches on an empty or missing id", () => {
    const blank = application(1, "", "");
    const inbound: InboundMessage[] = [
      { inReplyTo: "" },
      { inReplyTo: "<>" },
      { references: ["", "<>"] },
      { from: "" },
      {},
    ];

    expect(matchReplies([blank], inbound)).toEqual([]);
  });

  it("does not match a lookalike id from a different domain", () => {
    const ref = application(1, "<abc@example.com>");
    expect(matchReplies([ref], [{ inReplyTo: "<abc@example.com.evil.net>" }])).toEqual(
      []
    );
    expect(matchReplies([ref], [{ inReplyTo: "<xabc@example.com>" }])).toEqual([]);
  });
});

describe("matchReplies - batches", () => {
  it("keeps inbound order and matches each message independently", () => {
    const a = application(1, "<sent-1@mail.example.com>", "hr@a.com");
    const b = outreach(2, "<sent-2@mail.example.com>", "Bob <bob@b.com>");
    const inbound: InboundMessage[] = [
      { from: "spam@nowhere.com" },
      { references: ["<hop@x.com>", "<sent-2@mail.example.com>"] },
      { inReplyTo: "<SENT-1@Mail.Example.com>" },
      { from: "Bob <BOB@b.com>" },
    ];

    const matches = matchReplies([a, b], inbound);

    expect(matches.map((m) => [m.ref.id, m.matchedBy])).toEqual([
      [2, "references"],
      [1, "in-reply-to"],
      [2, "sender"],
    ]);
  });

  it("allows several inbound messages to answer the same ref", () => {
    const ref = application(1, "<sent-1@mail.example.com>");
    const inbound: InboundMessage[] = [
      { messageId: "<r1@corp.com>", inReplyTo: "<sent-1@mail.example.com>" },
      { messageId: "<r2@corp.com>", inReplyTo: "<sent-1@mail.example.com>" },
    ];

    const matches = matchReplies([ref], inbound);

    expect(matches).toHaveLength(2);
    expect(new Set(matches.map((m) => m.ref))).toEqual(new Set([ref]));
  });
});
