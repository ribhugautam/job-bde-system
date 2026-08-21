import { requireUser } from "@/lib/infra/session";
import { getProfile } from "@/lib/infra/db/profiles";
import { getActiveResume } from "@/lib/infra/db/documents";
import DbErrorNotice from "@/components/DbErrorNotice";
import ProfileEditor from "@/components/profile/ProfileEditor";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const user = await requireUser("/dashboard/profile");

  let data;
  try {
    const [profile, resume] = await Promise.all([
      getProfile(user.id),
      getActiveResume(user.id),
    ]);
    data = { profile, resume };
  } catch (err) {
    return <DbErrorNotice error={err} />;
  }

  const { profile, resume } = data;

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-(--text-muted)">
          Matching profile
        </h2>
        <p className="mt-1 text-xs text-(--text-dim)">
          Your job list has no filters — it is ranked against this. Everything
          here is yours alone; changing it never affects a colleague&apos;s list.
        </p>
      </div>

      {/*
        The state of the profile is stated up front rather than left implicit.
        Extraction is heuristic and gets things wrong, and a wrong profile is
        invisible in a ranked list -- jobs are simply in the wrong order, with
        nothing on screen to say why. Saying "this was guessed, check it" is the
        whole reason the profile is editable rather than hidden.
      */}
      {!profile.exists && (
        <div className="rounded border border-(--warn-fg) bg-(--warn-bg) p-3">
          <div className="text-sm font-semibold text-(--warn-fg)">
            Using the starter profile
          </div>
          <div className="mt-1 text-xs text-(--text-muted)">
            {resume
              ? "Your resume is on file but no profile was derived from it. Set your skills below."
              : "Upload your CV on the Resume page and your skills will be filled in automatically, or set them by hand below."}
          </div>
        </div>
      )}

      {profile.exists && profile.autoExtracted && (
        <div className="rounded border border-(--info-bg) bg-(--info-bg) p-3">
          <div className="text-sm font-semibold text-(--info-fg)">
            Read from your CV — worth checking
          </div>
          <div className="mt-1 text-xs text-(--text-muted)">
            These were guessed from your resume text, so expect a few misses.
            Once you save any change, uploading a new CV will no longer
            overwrite them.
          </div>
        </div>
      )}

      <div className="rounded border border-(--border) p-3">
        <ProfileEditor
          initialSkills={profile.skills}
          initialTargetRoles={profile.targetRoles}
          initialCareerStart={profile.careerStart}
          initialArrangements={profile.acceptedArrangements}
        />
      </div>

      {/*
        Stated rather than buried: geographic eligibility is derived once at
        ingest against India (lib/domain/facts/geo.ts) and stored on the shared
        job row, so it is the same answer for every user. Correct for this team;
        a real limitation for anyone hiring outside it, and much better said out
        loud than discovered through inexplicable rankings.
      */}
      <p className="text-[11px] text-(--text-faint)">
        Note: location eligibility is currently judged against India for
        everyone, because it is computed once per job rather than per person.
        Everything else on this page is yours alone.
      </p>
    </div>
  );
}
