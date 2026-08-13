import { defineConfig } from "vitest/config";

// `.mts` rather than `.ts` so Vite's native config loader reads it as ESM
// without the CommonJS interop warning.
//
// tsconfig path resolution is native now (`resolve.tsconfigPaths`), which is
// what makes "@/lib/..." resolve in tests exactly as it does in the Next build.
// Test imports therefore match source imports character for character, so a
// broken import path fails in CI rather than only at runtime.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests must not inherit a developer's real .env. Several of them mutate
    // process.env to exercise config validation, and picking up real
    // credentials would make results machine-dependent — or worse, let a test
    // make a live API call because a key happened to be present.
    env: {},
  },
});
