import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/.next/**", ".claude/worktrees/**"],
    // Multiple integration test files (tests/ingest.integration.test.ts,
    // tests/retrieval-keyword.integration.test.ts, tests/migration.test.ts) all
    // mutate the same shared Postgres schema and TRUNCATE between tests. Vitest's
    // default per-file parallelism interleaves their TRUNCATEs across separate
    // transactions on the same tables, deadlocking the test pool. Serializing
    // file execution costs ~30-60s in this 26-file repo but is the cheapest fix
    // that doesn't require either per-test DB isolation or wrapping every test
    // in its own SAVEPOINT (both materially more invasive).
    fileParallelism: false,
  },
});
