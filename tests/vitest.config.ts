import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/**
 * Alphabetical file order (the specs are number-prefixed), never the default
 * duration-cache order: fixtures build on each other only within a file, but
 * contracts must run first (schema presence) and pages last (uses fixtures'
 * leftovers being gone). Serial everything — one shared next dev instance and
 * per-user in-memory socket rate limits make parallel runs flaky for nothing.
 */
class AlphabeticalSequencer extends BaseSequencer {
  async sort(files: TestSpecification[]) {
    return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["specs/**/*.spec.ts"],
    fileParallelism: false,
    sequence: { concurrent: false, sequencer: AlphabeticalSequencer },
    globalSetup: "./global-setup.ts",
    // next dev compiles routes on first hit — generous timeouts, not flaky ones.
    testTimeout: 30_000,
    hookTimeout: 90_000,
    teardownTimeout: 60_000,
  },
});
