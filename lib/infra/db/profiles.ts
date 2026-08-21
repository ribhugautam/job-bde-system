import { eq } from "drizzle-orm";
import { getDb, schema } from "./client";
import {
  buildProfile,
  defaultProfile,
  type ScoringProfile,
} from "@/lib/domain/scoring/profile";

// ---------------------------------------------------------------------------
// Loading and saving one person's scoring profile.
//
// getProfile() ALWAYS returns a usable profile — never null. A user with no row
// yet still has to see a sensibly ranked job list, and forcing every call site
// to handle "no profile" would mean every one of them inventing its own
// fallback. There is one fallback, it lives in defaultProfile(), and it is
// documented there.
// ---------------------------------------------------------------------------

export type StoredProfile = ScoringProfile & {
  /** True while the values are still whatever extraction guessed. */
  autoExtracted: boolean;
  updatedAt: Date | null;
  /** False when this is the default profile rather than a stored row. */
  exists: boolean;
};

export async function getProfile(userId: number): Promise<StoredProfile> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(schema.userProfiles)
    .where(eq(schema.userProfiles.userId, userId))
    .limit(1);

  if (!row) {
    return { ...defaultProfile(), autoExtracted: true, updatedAt: null, exists: false };
  }

  // buildProfile is total: every field here comes out of a JSON column that a
  // human (or a future migration) could have written badly, and a malformed
  // profile must rank jobs oddly rather than 500 the page.
  return {
    ...buildProfile({
      skills: row.skills,
      targetRoles: row.targetRoles,
      vetoPhrases: row.vetoPhrases,
      careerStart: row.careerStart,
      acceptedArrangements: row.acceptedArrangements,
    }),
    autoExtracted: row.autoExtracted,
    updatedAt: row.updatedAt,
    exists: true,
  };
}

export async function saveProfile(
  userId: number,
  profile: ScoringProfile,
  opts: { autoExtracted: boolean; sourceDocumentId?: number }
): Promise<void> {
  const db = getDb();
  const values = {
    userId,
    skills: profile.skills,
    targetRoles: profile.targetRoles,
    vetoPhrases: profile.vetoPhrases,
    careerStart: profile.careerStart,
    acceptedArrangements: profile.acceptedArrangements,
    autoExtracted: opts.autoExtracted,
    sourceDocumentId: opts.sourceDocumentId ?? null,
    updatedAt: new Date(),
  };

  // Upsert on the primary key. One row per user is enforced by the schema, so
  // this cannot quietly create a second profile that shadows the first.
  await db
    .insert(schema.userProfiles)
    .values(values)
    .onConflictDoUpdate({ target: schema.userProfiles.userId, set: values });
}

/**
 * Stores an auto-extracted profile WITHOUT overwriting one the user has edited.
 *
 * Uploading a new CV should refresh a profile nobody has touched, and must not
 * silently discard weights and target roles somebody tuned by hand. Extraction
 * is a helpful guess; a human edit is an instruction.
 */
export async function saveExtractedProfile(
  userId: number,
  profile: ScoringProfile,
  sourceDocumentId: number
): Promise<{ applied: boolean }> {
  const existing = await getProfile(userId);
  if (existing.exists && !existing.autoExtracted) {
    return { applied: false };
  }
  await saveProfile(userId, profile, { autoExtracted: true, sourceDocumentId });
  return { applied: true };
}
