// ---------------------------------------------------------------------------
// Invite validity. Pure: takes a row-shaped object and a clock, returns a
// verdict. No database.
//
// Split out from the query layer so the interesting cases — spent, expired,
// revoked, and the exact expiry boundary — are testable without a database,
// and so there is ONE place that decides whether an invite may be redeemed.
// Two call sites each doing their own `if (!invite.acceptedAt)` is how a
// single-use token becomes reusable.
// ---------------------------------------------------------------------------

export const INVITE_TTL_DAYS = 7;

export type InviteRecord = {
  expiresAt: Date;
  acceptedAt?: Date | null;
  revokedAt?: Date | null;
};

export type InviteState = "valid" | "accepted" | "revoked" | "expired";

/**
 * Order matters and is deliberate: an invite that was redeemed and has since
 * passed its expiry reports as `accepted`, not `expired`, because "this was
 * already used" is the more useful thing to tell whoever is holding the link.
 */
export function inviteState(
  invite: InviteRecord,
  now: Date = new Date()
): InviteState {
  if (invite.acceptedAt) return "accepted";
  if (invite.revokedAt) return "revoked";
  // Expiry is exclusive: an invite is dead AT its expiry instant, not after it.
  if (invite.expiresAt.getTime() <= now.getTime()) return "expired";
  return "valid";
}

export function isRedeemable(
  invite: InviteRecord,
  now: Date = new Date()
): boolean {
  return inviteState(invite, now) === "valid";
}

/** What to tell the person holding a link that did not work. */
export function describeInviteState(state: InviteState): string {
  switch (state) {
    case "valid":
      return "This invite is valid.";
    case "accepted":
      return "This invite has already been used. Sign in instead, or ask for a new one.";
    case "revoked":
      return "This invite was withdrawn. Ask whoever invited you for a new one.";
    case "expired":
      return `This invite has expired (they last ${INVITE_TTL_DAYS} days). Ask for a new one.`;
  }
}

export function inviteExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}
