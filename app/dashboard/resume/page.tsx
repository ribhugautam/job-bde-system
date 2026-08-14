import { getActiveResume } from "@/lib/infra/db/documents";
import ResumeUpload from "@/components/ResumeUpload";
import DbErrorNotice from "@/components/DbErrorNotice";

export const dynamic = "force-dynamic";

export default async function ResumePage() {
  let resume;
  try {
    resume = await getActiveResume();
  } catch (err) {
    return <DbErrorNotice error={err} />;
  }

  return (
    <div className="max-w-2xl space-y-4">
      <h2 className="text-sm font-semibold text-(--text-muted)">Resume</h2>
      <div className="rounded border border-(--border) p-3 space-y-3">
        {resume ? (
          <div className="text-sm">
            <span className="text-(--ok-fg)">On file:</span>{" "}
            <span className="font-mono text-xs">{resume.filename}</span>{" "}
            <span className="text-xs text-(--text-dim)">
              ({(resume.sizeBytes / 1024).toFixed(0)} KB
              {resume.uploadedAt
                ? `, uploaded ${new Date(resume.uploadedAt).toLocaleDateString()}`
                : ""}
              )
            </span>
          </div>
        ) : (
          <div className="text-sm text-(--danger-fg)">
            No resume uploaded. Applications will be queued for review instead of
            sent — an application email with no CV attached is worse than none.
          </div>
        )}
        <ResumeUpload />
        <p className="text-xs text-(--text-dim)">
          PDF only, max 2MB. Attached to every application sent by email;
          deliberately not attached to cold freelance outreach (hurts spam
          scoring). Uploading replaces the active resume; older versions are
          kept so you can tell which CV went with which application.
        </p>
      </div>
    </div>
  );
}
