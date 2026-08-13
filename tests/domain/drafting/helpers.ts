// Shared assertions for the drafting tests. Not a spec file itself - vitest
// only collects tests/**/*.test.ts.
import { expect } from "vitest";

// Every one of these is something that has actually shipped in a cold email at
// some point in the industry, and each one is a template bug rather than a
// wording problem: a value that was supposed to be interpolated and wasn't.
const PLACEHOLDER_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "undefined", pattern: /\bundefined\b/ },
  { label: "null", pattern: /\bnull\b/ },
  { label: "NaN", pattern: /\bNaN\b/ },
  { label: "[object Object]", pattern: /\[object Object\]/ },
  { label: "unreplaced {{token}}", pattern: /\{\{[^}]*\}\}/ },
  { label: "unreplaced ${token}", pattern: /\$\{/ },
];

export function expectNoPlaceholderLeakage(text: string): void {
  for (const { label, pattern } of PLACEHOLDER_PATTERNS) {
    expect(
      pattern.test(text),
      `output leaked placeholder "${label}":\n${text}`
    ).toBe(false);
  }
}
