import Link from "next/link";
import { LogoutButton } from "@/components/LogoutButton";

const NAV = [
  { href: "/dashboard", label: "Overview" },
  { href: "/dashboard/jobs", label: "Jobs" },
  { href: "/dashboard/applications", label: "Applications" },
  { href: "/dashboard/leads", label: "Leads" },
  { href: "/dashboard/outreach", label: "Outreach" },
  { href: "/dashboard/settings", label: "Settings" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="border-b border-neutral-800 px-6 py-4">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Job & Freelance BDE Pipeline</h1>
          <LogoutButton />
        </div>
        <nav className="mt-3 flex gap-4 text-sm">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-neutral-400 hover:text-white transition"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="p-6">{children}</main>
      {/*
        ATTRIBUTION - REQUIRED, DO NOT REMOVE.
        Adzuna's terms require a visible "Jobs by Adzuna" credit wherever their
        results appear. Remotive and RemoteOK both state they will revoke API
        access without a credit/backlink. Deleting this block risks losing
        three of the eight job sources.
      */}
      <footer className="border-t border-neutral-900 px-6 py-4 text-xs text-neutral-600">
        Job data from{" "}
        <a href="https://himalayas.app" className="hover:text-neutral-400">
          Himalayas
        </a>
        ,{" "}
        <a href="https://jobicy.com" className="hover:text-neutral-400">
          Jobicy
        </a>
        ,{" "}
        <a href="https://remotive.com" className="hover:text-neutral-400">
          Remotive
        </a>
        ,{" "}
        <a href="https://remoteok.com" className="hover:text-neutral-400">
          RemoteOK
        </a>
        ,{" "}
        <a href="https://www.arbeitnow.com" className="hover:text-neutral-400">
          Arbeitnow
        </a>
        ,{" "}
        <a href="https://weworkremotely.com" className="hover:text-neutral-400">
          We Work Remotely
        </a>{" "}
        and{" "}
        <a href="https://www.adzuna.com" className="hover:text-neutral-400">
          Jobs by Adzuna
        </a>
        .
      </footer>
    </div>
  );
}
