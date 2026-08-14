import Link from "next/link";
import { LogoutButton } from "@/components/LogoutButton";
import RunPipelineButton from "@/components/RunPipelineButton";

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/queue", label: "Queue" },
  { href: "/dashboard/jobs", label: "Jobs" },
  { href: "/dashboard/applications", label: "Applications" },
  { href: "/dashboard/freelance", label: "Freelance" },
  { href: "/dashboard/resume", label: "Resume" },
  { href: "/dashboard/settings", label: "Settings" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const dryRun = process.env.DRY_RUN === "1";
  return (
    <div className="flex min-h-screen flex-col bg-(--bg) text-(--text)">
      <header className="relative border-b border-(--border) px-6 py-3">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-sm font-semibold tracking-tight">Job &amp; Freelance Pipeline</h1>
          <div className="flex items-center gap-3">
            <RunPipelineButton dryRun={dryRun} />
            <LogoutButton />
          </div>
        </div>
        <nav className="mt-2 flex gap-4 text-xs">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-(--text-muted) transition hover:text-(--text)"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="flex-1 p-6">{children}</main>
      {/*
        ATTRIBUTION - REQUIRED, DO NOT REMOVE.
        Adzuna's terms require a visible "Jobs by Adzuna" credit wherever their
        results appear. Remotive and RemoteOK both state they will revoke API
        access without a credit/backlink. Deleting this block risks losing
        three of the eight job sources.
      */}
      <footer className="border-t border-(--border) px-6 py-4 text-xs text-(--text-faint)">
        Job data from{" "}
        <a href="https://himalayas.app" className="hover:text-(--text-muted)">
          Himalayas
        </a>
        ,{" "}
        <a href="https://jobicy.com" className="hover:text-(--text-muted)">
          Jobicy
        </a>
        ,{" "}
        <a href="https://remotive.com" className="hover:text-(--text-muted)">
          Remotive
        </a>
        ,{" "}
        <a href="https://remoteok.com" className="hover:text-(--text-muted)">
          RemoteOK
        </a>
        ,{" "}
        <a href="https://www.arbeitnow.com" className="hover:text-(--text-muted)">
          Arbeitnow
        </a>
        ,{" "}
        <a href="https://weworkremotely.com" className="hover:text-(--text-muted)">
          We Work Remotely
        </a>
        ,{" "}
        <a href="https://www.adzuna.com" className="hover:text-(--text-muted)">
          Jobs by Adzuna
        </a>
        ,{" "}
        <a href="https://www.ycombinator.com" className="hover:text-(--text-muted)">
          Y Combinator
        </a>
        ,{" "}
        <a href="https://wellfound.com" className="hover:text-(--text-muted)">
          Wellfound
        </a>{" "}
        and{" "}
        <a href="https://www.indeed.com" className="hover:text-(--text-muted)">
          Indeed
        </a>
        .
      </footer>
    </div>
  );
}
