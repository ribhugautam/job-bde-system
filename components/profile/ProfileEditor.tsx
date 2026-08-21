"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson } from "@/lib/infra/http/postJson";
import { TAXONOMY_NAMES, findTaxonomySkill } from "@/lib/domain/scoring/taxonomy";
import type { ProfileSkill } from "@/lib/domain/scoring/profile";
import type { WorkArrangement } from "@/lib/domain/facts";

const ARRANGEMENTS: { value: WorkArrangement; label: string }[] = [
  { value: "remote", label: "remote" },
  { value: "hybrid", label: "hybrid" },
  { value: "onsite", label: "on-site" },
];

function toDateInput(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

export default function ProfileEditor({
  initialSkills,
  initialTargetRoles,
  initialCareerStart,
  initialArrangements,
}: {
  initialSkills: ProfileSkill[];
  initialTargetRoles: string[];
  initialCareerStart: Date | null;
  initialArrangements: WorkArrangement[];
}) {
  const router = useRouter();
  const [skills, setSkills] = useState<ProfileSkill[]>(initialSkills);
  const [targetRoles, setTargetRoles] = useState(initialTargetRoles.join(", "));
  const [careerStart, setCareerStart] = useState(toDateInput(initialCareerStart));
  const [arrangements, setArrangements] = useState<WorkArrangement[]>(initialArrangements);
  const [newSkill, setNewSkill] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function dirty() {
    setSaved(false);
  }

  function addSkill(name: string) {
    const key = name.trim().toLowerCase();
    if (!key || skills.some((s) => s.name === key)) return;
    // Pull the alias list from the taxonomy so a manually added skill still
    // matches the way an extracted one does. A skill with no aliases matches
    // only its own literal name, which silently under-scores things like
    // "node" vs "node.js".
    const known = findTaxonomySkill(key);
    setSkills([
      ...skills,
      { name: key, weight: known?.weight ?? 2, aliases: known?.aliases },
    ]);
    setNewSkill("");
    dirty();
  }

  async function onSave() {
    setSaving(true);
    setError(null);
    const res = await postJson("/api/actions/update-profile", {
      skills,
      targetRoles: targetRoles.split(",").map((r) => r.trim()).filter(Boolean),
      careerStart: careerStart || null,
      acceptedArrangements: arrangements,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSaved(true);
    router.refresh();
  }

  const unused = TAXONOMY_NAMES.filter((n) => !skills.some((s) => s.name === n));

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-1 text-xs font-semibold text-(--text-muted)">
          Skills ({skills.length})
        </h3>
        <p className="mb-2 text-[11px] text-(--text-faint)">
          Weight is how much a job mentioning this counts. Removing skills you
          don&apos;t have matters as much as adding ones you do — scores are
          scaled against your total, so padding the list flattens the ranking.
        </p>
        <div className="rounded border border-(--border)">
          {skills.map((skill, i) => (
            <div
              key={skill.name}
              className="flex items-center justify-between gap-2 border-b border-(--border) px-2 py-1 last:border-b-0"
            >
              <span className="font-mono text-[11px] text-(--text)">{skill.name}</span>
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={1}
                  max={5}
                  value={skill.weight}
                  onChange={(e) => {
                    const next = [...skills];
                    next[i] = { ...skill, weight: Number(e.target.value) };
                    setSkills(next);
                    dirty();
                  }}
                  className="w-24"
                />
                <span className="tnum w-3 text-[11px] text-(--text-dim)">
                  {skill.weight}
                </span>
                <button
                  onClick={() => {
                    setSkills(skills.filter((s) => s.name !== skill.name));
                    dirty();
                  }}
                  className="rounded border border-(--border-strong) px-1.5 text-[11px] text-(--text-muted) hover:text-(--danger-fg)"
                >
                  remove
                </button>
              </div>
            </div>
          ))}
          {skills.length === 0 && (
            <p className="px-2 py-3 text-[11px] text-(--danger-fg)">
              No skills. Every job will score 0 until you add some.
            </p>
          )}
        </div>

        <div className="mt-2 flex items-center gap-2">
          <input
            list="skill-taxonomy"
            value={newSkill}
            onChange={(e) => setNewSkill(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addSkill(newSkill);
              }
            }}
            placeholder="add a skill…"
            className="w-48 rounded border border-(--border-strong) bg-transparent px-2 py-0.5 text-[11px] text-(--text) placeholder:text-(--text-faint)"
          />
          <datalist id="skill-taxonomy">
            {unused.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <button
            onClick={() => addSkill(newSkill)}
            className="rounded border border-(--border-strong) px-2 py-0.5 text-[11px] text-(--text-muted) hover:text-(--text)"
          >
            add
          </button>
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-semibold text-(--text-muted)">Target roles</h3>
        <p className="mb-2 text-[11px] text-(--text-faint)">
          Comma separated. A job title matching one of these gets a bonus.
        </p>
        <textarea
          value={targetRoles}
          onChange={(e) => {
            setTargetRoles(e.target.value);
            dirty();
          }}
          rows={3}
          className="w-full rounded border border-(--border-strong) bg-transparent px-2 py-1 text-[11px] text-(--text)"
        />
      </section>

      <section>
        <h3 className="mb-1 text-xs font-semibold text-(--text-muted)">
          Career start
        </h3>
        <p className="mb-2 text-[11px] text-(--text-faint)">
          Used to judge experience requirements. Leave blank and experience is
          ignored entirely rather than guessed at.
        </p>
        <input
          type="date"
          value={careerStart}
          onChange={(e) => {
            setCareerStart(e.target.value);
            dirty();
          }}
          className="rounded border border-(--border-strong) bg-transparent px-2 py-0.5 text-[11px] text-(--text)"
        />
      </section>

      <section>
        <h3 className="mb-1 text-xs font-semibold text-(--text-muted)">
          Work arrangements you&apos;ll take
        </h3>
        <p className="mb-2 text-[11px] text-(--text-faint)">
          A ranking preference, not a filter — anything you don&apos;t pick is
          pushed down the list rather than hidden, so an outstanding hybrid role
          can still surface.
        </p>
        <div className="flex gap-1.5">
          {ARRANGEMENTS.map((option) => {
            const active = arrangements.includes(option.value);
            return (
              <button
                key={option.value}
                onClick={() => {
                  setArrangements(
                    active
                      ? arrangements.filter((a) => a !== option.value)
                      : [...arrangements, option.value]
                  );
                  dirty();
                }}
                className={`rounded border px-2 py-0.5 text-[11px] transition ${
                  active
                    ? "border-(--border-strong) bg-(--surface-hover) text-(--text)"
                    : "border-(--border-strong) text-(--text-muted) hover:text-(--text)"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </section>

      <div className="flex items-center gap-3 border-t border-(--border) pt-3">
        <button
          onClick={onSave}
          disabled={saving}
          className="rounded bg-(--ok-bg) px-3 py-1 text-xs font-medium text-(--ok-fg) hover:brightness-125 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save profile"}
        </button>
        {saved && <span className="text-[11px] text-(--ok-fg)">Saved.</span>}
        {error && <span className="text-[11px] text-(--danger-fg)">{error}</span>}
      </div>
    </div>
  );
}
