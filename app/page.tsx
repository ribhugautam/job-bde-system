import Link from "next/link";
import { CANDIDATE, LINKS } from "@/lib/domain/scoring/resume-profile";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-950 px-6 text-center text-neutral-100">
      <h1 className="text-2xl font-semibold">{CANDIDATE.name}&apos;s Job &amp; Freelance Pipeline</h1>
      <p className="mt-2 max-w-md text-sm text-neutral-400">
        Daily remote job matching, drafted applications, and freelance/contract outreach - reviewed
        and approved from the dashboard.
      </p>
      <Link
        href="/dashboard"
        className="mt-6 rounded-full bg-white px-6 py-2 text-sm font-medium text-black hover:bg-neutral-200"
      >
        Open dashboard
      </Link>
      <div className="mt-8 flex gap-4 text-xs text-neutral-500">
        <a href={LINKS.linkedin} className="hover:text-neutral-300">LinkedIn</a>
        <a href={LINKS.github} className="hover:text-neutral-300">GitHub</a>
        <a href={LINKS.portfolio} className="hover:text-neutral-300">Portfolio</a>
        <a href={LINKS.ziro} className="hover:text-neutral-300">Ziro</a>
      </div>
    </div>
  );
}
