import type { GeoEligibility, WorkArrangement } from "@/lib/domain/facts";
import type { ChipTone } from "@/components/ui/Chip";

// ---------------------------------------------------------------------------
// Which facts become chips, and what each one means.
//
// A pure function returning DESCRIPTORS rather than JSX, so the rules are unit-
// testable without a React testing stack — see the note in the plan's global
// constraints on why this repo has none.
//
// `unknown` never produces a chip. It is the honest absence of evidence, and a
// row that announces "unknown / unknown" is louder than one that says nothing.
// ---------------------------------------------------------------------------

export type FactChip = { label: string; tone: ChipTone };

export type ChippableJob = {
  geoEligibility?: GeoEligibility | string | null;
  arrangement?: WorkArrangement | string | null;
  minYears?: number | null;
  easyApply?: boolean | null;
};

const GEO: Record<string, FactChip> = {
  eligible: { label: "eligible", tone: "ok" },
  // worldwide and eligible both score +10, but they assert different things:
  // one states no restriction at all, the other that you specifically qualify.
  worldwide: { label: "worldwide", tone: "info" },
  restricted: { label: "restricted", tone: "danger" },
};

const ARRANGEMENT: Record<string, FactChip> = {
  remote: { label: "remote", tone: "neutral" },
  hybrid: { label: "hybrid", tone: "warn" },
  onsite: { label: "on-site", tone: "warn" },
};

export function jobFactChips(job: ChippableJob): FactChip[] {
  const chips: FactChip[] = [];

  const geo = job.geoEligibility ? GEO[job.geoEligibility] : undefined;
  if (geo) chips.push(geo);

  const arrangement = job.arrangement ? ARRANGEMENT[job.arrangement] : undefined;
  if (arrangement) chips.push(arrangement);

  if (typeof job.minYears === "number") {
    chips.push({ label: `${job.minYears}y+`, tone: "neutral" });
  }

  if (job.easyApply === true) {
    chips.push({ label: "easy apply", tone: "neutral" });
  }

  return chips;
}
