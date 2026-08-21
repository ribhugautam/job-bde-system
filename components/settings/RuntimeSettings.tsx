"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/infra/http/postJson";
import { MAX_WORKER_BUDGET_MS, type Settings } from "@/lib/config/settings";

// ---------------------------------------------------------------------------
// The admin-only settings form.
//
// Every field here used to be an environment variable, which meant a Vercel
// edit and a redeploy to change a number. Fields are grouped the way an
// operator thinks about them rather than the way they were ordered in .env.
// ---------------------------------------------------------------------------

type NumberField = {
  key: keyof Settings;
  label: string;
  hint: string;
  min: number;
  max: number;
};

const MATCHING: NumberField[] = [
  {
    key: "MATCH_THRESHOLD",
    label: "Match threshold",
    hint: "Fit score a job must reach before anything is drafted for it.",
    min: 0,
    max: 100,
  },
  {
    key: "JOB_STALE_DAYS",
    label: "Inbox staleness (days)",
    hint: "Untriaged jobs older than this move to Archive. Nothing is deleted; changing it reflows both piles instantly.",
    min: 1,
    max: 365,
  },
];

const SENDING: NumberField[] = [
  {
    key: "OUTREACH_DAILY_CAP",
    label: "Freelance outreach per day",
    hint: "Cold pitches are rate-limited; applications to advertised addresses are not.",
    min: 0,
    max: 200,
  },
  {
    key: "FOLLOWUP_FIRST_DAYS",
    label: "First follow-up (days)",
    hint: "Days after sending before the first nudge.",
    min: 1,
    max: 60,
  },
  {
    key: "FOLLOWUP_FINAL_DAYS",
    label: "Final follow-up (days)",
    hint: "Must be later than the first, or both fire in the same run.",
    min: 2,
    max: 120,
  },
  {
    key: "FOLLOWUP_DAILY_CAP",
    label: "Follow-ups per day",
    hint: "Across applications and outreach combined.",
    min: 0,
    max: 200,
  },
];

const ENRICHMENT: NumberField[] = [
  {
    key: "LINKEDIN_ENRICH_DAILY_CAP",
    label: "LinkedIn pages per day",
    hint: "Public job pages fetched to recover descriptions. Results are cached permanently, including failures.",
    min: 0,
    max: 500,
  },
  {
    key: "LINKEDIN_ENRICH_DELAY_MS",
    label: "Delay between pages (ms)",
    hint: "Spacing between fetches, so a run cannot turn into a burst.",
    min: 0,
    max: 60_000,
  },
  {
    key: "LINKEDIN_ALERT_DAYS",
    label: "Alert email lookback (days)",
    hint: "How far back to scan your inbox for job-alert emails each run.",
    min: 1,
    max: 30,
  },
];

const WORKER: NumberField[] = [
  {
    key: "WORKER_TIME_BUDGET_MS",
    label: "Worker time budget (ms)",
    hint: `Capped at ${MAX_WORKER_BUDGET_MS.toLocaleString()} because the function itself times out at 60s and the worker reserves 17s for its tail stages.`,
    min: 1_000,
    max: MAX_WORKER_BUDGET_MS,
  },
  {
    key: "WORKER_BATCH_SIZE",
    label: "Rows per batch",
    hint: "How many rows each stage claims per pass.",
    min: 1,
    max: 500,
  },
];

const TOGGLES: { key: keyof Settings; label: string; hint: string }[] = [
  {
    key: "ENABLE_LINKEDIN_ALERTS",
    label: "LinkedIn alert emails",
    hint: "Reads LinkedIn job alerts from your own inbox over IMAP, read-only. Needs IMAP credentials in env.",
  },
  {
    key: "ENABLE_WELLFOUND_ALERTS",
    label: "Wellfound alert emails",
    hint: "Same approach: your inbox, read-only. No Wellfound account is authenticated.",
  },
  {
    key: "ENABLE_INDEED_ALERTS",
    label: "Indeed alert emails",
    hint: "High volume, and skewed toward agency postings — expect the role veto to do real work.",
  },
  {
    key: "ENABLE_LINKEDIN_ENRICH",
    label: "LinkedIn description recovery",
    hint: "Fetches the public job page (no login, no cookie) to recover descriptions alerts omit.",
  },
  {
    key: "ENABLE_FOLLOWUPS",
    label: "Follow-up emails",
    hint: "A reply always cancels any pending follow-up.",
  },
];

// Defined at module scope, NOT inside the component. A component created during
// render is a new type on every render, so React unmounts and remounts it —
// which in a form of number inputs means the field loses focus after every
// single keystroke.
function NumberRow({
  field,
  value,
  onChange,
}: {
  field: NumberField;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-(--border) py-2 last:border-b-0">
      <div className="min-w-0">
        <div className="text-xs text-(--text)">{field.label}</div>
        <div className="text-[11px] text-(--text-dim)">{field.hint}</div>
      </div>
      <input
        type="number"
        min={field.min}
        max={field.max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="tnum w-24 shrink-0 rounded border border-(--border-strong) bg-transparent px-2 py-1 text-right text-xs text-(--text)"
      />
    </div>
  );
}

function Section({
  title,
  fields,
  values,
  onChange,
}: {
  title: string;
  fields: NumberField[];
  values: Settings;
  onChange: (key: keyof Settings, value: number) => void;
}) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold text-(--text-muted)">{title}</h3>
      <div className="rounded border border-(--border) px-3">
        {fields.map((f) => (
          <NumberRow
            key={f.key}
            field={f}
            value={values[f.key] as number}
            onChange={(v) => onChange(f.key, v)}
          />
        ))}
      </div>
    </div>
  );
}

export default function RuntimeSettings({
  settings,
  inertEnv,
  envForcesDryRun,
}: {
  settings: Settings;
  inertEnv: string[];
  envForcesDryRun: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Settings>(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setSaved(false);
  }

  async function onSave() {
    setBusy(true);
    setError(null);
    const res = await postJson("/api/admin/settings", values);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSaved(true);
    router.refresh();
  }

  return (
    <div className="space-y-5">
      {/*
        Named explicitly rather than left to be discovered. Somebody raising
        MATCH_THRESHOLD in Vercel, redeploying and watching nothing change is
        exactly the afternoon this warning exists to save.
      */}
      {inertEnv.length > 0 && (
        <div className="rounded border border-(--warn-fg) bg-(--warn-bg) p-3">
          <div className="text-xs font-semibold text-(--warn-fg)">
            {inertEnv.length} environment variable
            {inertEnv.length === 1 ? " is" : "s are"} now ignored
          </div>
          <div className="mt-1 text-[11px] text-(--text-muted)">
            These moved here and are no longer read from the environment. Delete
            them from your deployment to avoid confusion:
          </div>
          <code className="mt-1 block break-words font-mono text-[11px] text-(--text)">
            {inertEnv.join(", ")}
          </code>
        </div>
      )}

      <div>
        <h3 className="mb-1 text-xs font-semibold text-(--text-muted)">Sending</h3>
        <div
          className={`rounded border p-3 ${
            values.DRY_RUN || envForcesDryRun
              ? "border-(--warn-fg) bg-(--warn-bg)"
              : "border-(--danger-fg) bg-(--danger-bg)"
          }`}
        >
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={values.DRY_RUN || envForcesDryRun}
              disabled={envForcesDryRun}
              onChange={(e) => set("DRY_RUN", e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span
                className={`block text-xs font-semibold ${
                  values.DRY_RUN || envForcesDryRun
                    ? "text-(--warn-fg)"
                    : "text-(--danger-fg)"
                }`}
              >
                Dry run — draft everything, send nothing
              </span>
              <span className="mt-0.5 block text-[11px] text-(--text-muted)">
                {envForcesDryRun
                  ? "Forced on by DRY_RUN in the environment. That is a deploy-level stop and cannot be lifted from here — remove the variable and redeploy to allow sending."
                  : values.DRY_RUN
                    ? "Nothing leaves the building, including the digest."
                    : "LIVE. Applications auto-send to listings that publish an apply-by-email address, and outreach sends up to the daily cap."}
              </span>
            </span>
          </label>
        </div>
      </div>

      <Section
        title="Matching"
        fields={MATCHING}
        values={values}
        onChange={(key, v) => set(key, v as never)}
      />

      <div>
        <h3 className="mb-1 text-xs font-semibold text-(--text-muted)">Sources</h3>
        <div className="rounded border border-(--border) px-3">
          {TOGGLES.map((t) => (
            <div
              key={t.key}
              className="flex items-center justify-between gap-3 border-b border-(--border) py-2 last:border-b-0"
            >
              <div className="min-w-0">
                <div className="text-xs text-(--text)">{t.label}</div>
                <div className="text-[11px] text-(--text-dim)">{t.hint}</div>
              </div>
              <input
                type="checkbox"
                checked={values[t.key] as boolean}
                onChange={(e) => set(t.key, e.target.checked as never)}
                className="shrink-0"
              />
            </div>
          ))}
        </div>
      </div>

      <Section
        title="Sending cadence"
        fields={SENDING}
        values={values}
        onChange={(key, v) => set(key, v as never)}
      />
      <Section
        title="Enrichment"
        fields={ENRICHMENT}
        values={values}
        onChange={(key, v) => set(key, v as never)}
      />
      <Section
        title="Worker"
        fields={WORKER}
        values={values}
        onChange={(key, v) => set(key, v as never)}
      />

      <div className="flex items-center gap-3 border-t border-(--border) pt-3">
        <button
          onClick={onSave}
          disabled={busy}
          className="rounded bg-(--ok-bg) px-3 py-1 text-xs font-medium text-(--ok-fg) hover:brightness-125 disabled:opacity-50"
        >
          {busy ? "Saving..." : "Save settings"}
        </button>
        {saved && <span className="text-[11px] text-(--ok-fg)">Saved.</span>}
        {error && <span className="text-[11px] text-(--danger-fg)">{error}</span>}
      </div>
    </div>
  );
}
