import { describe, expect, it } from "vitest";
import {
  INVITE_TTL_DAYS,
  describeInviteState,
  inviteExpiry,
  inviteState,
  isRedeemable,
} from "@/lib/domain/users/invites";

const NOW = new Date("2026-08-21T12:00:00Z");
const future = (ms: number) => new Date(NOW.getTime() + ms);

describe("inviteState", () => {
  it("is valid for an unspent, unrevoked, unexpired invite", () => {
    expect(inviteState({ expiresAt: future(60_000) }, NOW)).toBe("valid");
  });

  it("is accepted once redeemed", () => {
    expect(
      inviteState({ expiresAt: future(60_000), acceptedAt: NOW }, NOW)
    ).toBe("accepted");
  });

  it("is revoked when withdrawn", () => {
    expect(
      inviteState({ expiresAt: future(60_000), revokedAt: NOW }, NOW)
    ).toBe("revoked");
  });

  it("reports accepted, not expired, for a redeemed invite that later aged out", () => {
    // Order of the checks, asserted deliberately. "You already used this" is
    // the useful thing to tell whoever is holding the link; "it expired" would
    // send them to ask for a new one they do not need.
    expect(
      inviteState({ expiresAt: future(-60_000), acceptedAt: future(-120_000) }, NOW)
    ).toBe("accepted");
  });

  it("treats expiry as exclusive: dead AT the instant, not after it", () => {
    // The boundary, pinned. An off-by-one here is a token that lives a moment
    // longer than the policy says.
    expect(inviteState({ expiresAt: NOW }, NOW)).toBe("expired");
    expect(inviteState({ expiresAt: future(1) }, NOW)).toBe("valid");
    expect(inviteState({ expiresAt: future(-1) }, NOW)).toBe("expired");
  });

  it("treats null acceptedAt/revokedAt the same as absent", () => {
    // The database hands back null, not undefined. If these were truthy-tested
    // sloppily a fresh invite would read as spent.
    expect(
      inviteState(
        { expiresAt: future(60_000), acceptedAt: null, revokedAt: null },
        NOW
      )
    ).toBe("valid");
  });
});

describe("isRedeemable", () => {
  it("is true only for the valid state", () => {
    expect(isRedeemable({ expiresAt: future(60_000) }, NOW)).toBe(true);
    expect(isRedeemable({ expiresAt: future(-1) }, NOW)).toBe(false);
    expect(isRedeemable({ expiresAt: future(60_000), acceptedAt: NOW }, NOW)).toBe(false);
    expect(isRedeemable({ expiresAt: future(60_000), revokedAt: NOW }, NOW)).toBe(false);
  });
});

describe("inviteExpiry", () => {
  it("is the configured TTL ahead of now", () => {
    expect(inviteExpiry(NOW).getTime()).toBe(
      NOW.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000
    );
  });

  it("produces an invite that is immediately redeemable", () => {
    expect(isRedeemable({ expiresAt: inviteExpiry(NOW) }, NOW)).toBe(true);
  });
});

describe("describeInviteState", () => {
  it("gives every state a message that says what to do next", () => {
    for (const state of ["valid", "accepted", "revoked", "expired"] as const) {
      const message = describeInviteState(state);
      expect(message.length, state).toBeGreaterThan(0);
    }
    expect(describeInviteState("accepted")).toContain("Sign in");
    expect(describeInviteState("expired")).toContain(String(INVITE_TTL_DAYS));
  });
});
