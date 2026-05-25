import { defineConfig } from "vitest/config";
import path from "node:path";

// vitest.e2e.config.ts — separate config for end-to-end specs per
// ADR-0014. Only included from `npm run e2e`; default `npm test` and
// `npm run check` never invoke this config so they never spawn a
// `next start` subprocess.
//
// File pattern: tests/*.e2e.test.ts (excluded from the default config).
// Gating: specs themselves require DATABASE_URL (mirrors the
// tests/*.integration.test.ts pattern). If DATABASE_URL is unset, specs
// skip locally and throw in CI.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.e2e.test.ts"],
    exclude: ["**/node_modules/**", "**/.next/**", ".claude/worktrees/**"],
    // e2e specs spawn a real `next start` per describe block. Cold-start is
    // ~3-5s per server, and the server is the load-bearing shared resource;
    // file-parallelism with two parallel servers wastes resources and risks
    // port-allocation races. Single-threaded execution.
    fileParallelism: false,
    // Generous default timeout — `next start` cold-start + first request
    // can be slow under CI load (especially the first cold render of an
    // app/ route).
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
