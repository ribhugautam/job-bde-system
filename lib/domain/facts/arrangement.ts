import type { WorkArrangement } from "./types";

// ---------------------------------------------------------------------------
// Where the work physically happens.
//
// This absorbs inferRemote() from lib/infra/linkedin/alerts.ts and widens its
// boolean-plus-undefined result to four states. LinkedIn states the
// arrangement inside the location line — "Bengaluru (On-site)", "Pune Division
// (Hybrid)", "India (Remote)" — which is why location is the primary evidence.
//
// The job DESCRIPTION is deliberately NOT scanned. Descriptions mention
// "hybrid" and "remote" in passing constantly ("our hybrid cloud", "remote
// procedure call", "we were remote-first until 2022"), and every such mention
// would produce a confident wrong answer. Every source this system reads either
// states the arrangement in the location line or is a remote-only board that
// sets the flag, so the description adds noise and no signal.
// ---------------------------------------------------------------------------

const HYBRID_RE = /\bhybrid\b/i;
const ONSITE_RE = /\b(on[\s-]?site|onsite|in[\s-]?office|in\s+person)\b/i;
const REMOTE_RE =
  /\b(remote|work from home|wfh|anywhere|worldwide|distributed|telecommute)\b/i;

export type ArrangementInput = {
  location?: string;
  tags?: string[];
  /** What the source asserted, if anything. Remote-only boards hardcode true. */
  remote?: boolean;
};

/**
 * Precedence, most specific evidence first:
 *   1. the location line, where LinkedIn and most boards state it explicitly
 *   2. tags
 *   3. the source's own flag
 *   4. unknown
 *
 * Hybrid is tested before on-site and remote because a hybrid posting usually
 * names all three ("Hybrid — 3 days on-site, 2 remote") and hybrid is the
 * answer that carries the most information.
 */
export function deriveArrangement(input: ArrangementInput): WorkArrangement {
  const fromText = (text?: string): WorkArrangement | undefined => {
    if (!text) return undefined;
    if (HYBRID_RE.test(text)) return "hybrid";
    if (ONSITE_RE.test(text)) return "onsite";
    if (REMOTE_RE.test(text)) return "remote";
    return undefined;
  };

  return (
    fromText(input.location) ??
    fromText((input.tags ?? []).join(" ")) ??
    (input.remote === true ? "remote" : input.remote === false ? "onsite" : undefined) ??
    "unknown"
  );
}
