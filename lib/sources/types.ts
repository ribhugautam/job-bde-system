export type RawJob = {
  source: string;
  sourceId: string;
  title: string;
  company: string;
  companyUrl?: string;
  url: string;
  applyEmail?: string;
  location?: string;
  remote?: boolean;
  salaryText?: string;
  tags?: string[];
  description?: string;
  postedAt?: Date;
};

export type RawLead = {
  source: string;
  sourceId: string;
  title: string;
  clientOrCompany?: string;
  url: string;
  contactEmail?: string;
  budgetText?: string;
  description?: string;
  postedAt?: Date;
};

// A source fetcher must never throw past this boundary - the daily cron
// keeps going even if one source is down or has changed its API shape.
export async function safeFetchSource<T>(
  name: string,
  fn: () => Promise<T[]>
): Promise<{ items: T[]; error?: string }> {
  try {
    const items = await fn();
    return { items };
  } catch (err) {
    return {
      items: [],
      error: `${name}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Pulls an email address out of free-text job descriptions when a listing
// publishes a plain "apply to x@y.com" address. Deliberately conservative -
// we only auto-send to addresses that are explicitly published in the
// listing itself, never to addresses we infer or guess.
export function extractApplyEmail(text?: string): string | undefined {
  if (!text) return undefined;
  const match = text.match(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/
  );
  return match?.[0];
}
