// evals/run.test.ts — Wiring-guard tests for the eval runner's run-mode
// behavior. Unit-level; does NOT exercise the orchestrator end-to-end
// (that's the manual smoke per the eval-runner header). What this file
// proves is that the *guards* fire when they should:
//
//   - DATABASE_URL missing → pipelineAdapter throws loud at retrieve()
//     time, not at module-load (so `--lint-only` doesn't need a DB).
//   - EMBEDDING_PROVIDER override → pinStubProviders rejects non-stub
//     values up front rather than letting the ANN WHERE filter silently
//     return zero rows.
//   - RERANK_PROVIDER override → same shape.
//   - role=user actually sees `internal` sensitivity (regression pin on
//     the M3 #6 + #7 Phase-B assumption — see lib/auth.ts:194-195).
//
// The production-wiring path (Adapter → evalRetrieve → orchestrator → DB
// → ANN+keyword fusion → rerank) is verified by `npm run eval` against
// local Postgres with seeded entries (manual smoke per WORKFLOW.md
// verification-layer-matching: the gate that exercises the surface is
// the surface, not a stubbed mirror).
//
// Negative-assertion discipline (WORKFLOW.md): each test constructs a
// scenario where the guard's *absence* would produce a different result.
// E.g., the DATABASE_URL test asserts the throw happens — without the
// guard, the call would propagate to evalRetrieve, attempt to construct
// a Pool, and fail later with a less actionable error.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sensitivityAllowedForRole } from "@/lib/auth";

describe("evals/run.ts — wiring guards", () => {
  // Snapshot + restore env so a polluted state from a sibling test
  // can't leak in or out.
  const ORIGINAL_ENV: Record<string, string | undefined> = {};

  beforeEach(() => {
    ORIGINAL_ENV.DATABASE_URL = process.env.DATABASE_URL;
    ORIGINAL_ENV.EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER;
    ORIGINAL_ENV.RERANK_PROVIDER = process.env.RERANK_PROVIDER;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe("sensitivityAllowedForRole pin — role=user must see 'internal'", () => {
    // This is the load-bearing assumption behind the entire Phase-B
    // eval wire-up: seeded synthetic-fixture entries are sensitivity
    // 'internal', and the adapter calls evalRetrieve(query, "user").
    // If a future ADR flips role policy and "user" stops including
    // "internal", every measured case in the eval silently goes to
    // recall@5=0 because the ANN sensitivity predicate drops the only
    // matching rows. This regression test fails LOUD if that pin moves.
    it("includes 'internal' (eval's Phase-B sensitivity assumption)", () => {
      const allowed = sensitivityAllowedForRole("user");
      expect(allowed).toContain("internal");
    });

    it("also includes 'public' (sanity — admin is not the only role with access)", () => {
      const allowed = sensitivityAllowedForRole("user");
      expect(allowed).toContain("public");
    });

    it("does NOT include 'restricted' (sanity — eval doesn't accidentally widen sensitivity)", () => {
      const allowed = sensitivityAllowedForRole("user");
      expect(allowed).not.toContain("restricted");
    });
  });

  describe("pinStubProviders — env-override guards", () => {
    // The guards live as a free function in evals/run.ts. We can't import
    // it directly without invoking main(), so we mirror the assertion
    // logic here and pin the public contract via the error-message
    // shape — the function is forbidden from being silently bypassed.
    //
    // If pinStubProviders is refactored away, these tests fail and force
    // a re-think. The mirror is intentional: the guards are a thin
    // wrapper around stdlib env checks, and the *cost* of bypassing
    // them (zero-row ANN due to model+version mismatch) is high enough
    // that a contract test pinning their existence is worth more than
    // an importable-and-unit-tested helper that's also bypassable.

    it("EMBEDDING_PROVIDER=voyage MUST be rejected up front (not silently used)", async () => {
      // Without the guard, evalRetrieve would resolve a non-stub embedder
      // whose vectors mismatch the seeded stub-sha256 / v1 chunks; the
      // ANN WHERE filter returns zero rows; recall@5 silently goes to
      // zero. Guard converts the silent failure into a loud one.
      process.env.EMBEDDING_PROVIDER = "voyage";
      const { pinStubProviders } = await import("./run-adapter");
      expect(() => pinStubProviders()).toThrow(/EMBEDDING_PROVIDER/);
    });

    it("RERANK_PROVIDER=voyage MUST be rejected up front", async () => {
      process.env.RERANK_PROVIDER = "voyage";
      const { pinStubProviders } = await import("./run-adapter");
      expect(() => pinStubProviders()).toThrow(/RERANK_PROVIDER/);
    });

    it("unset envs are pinned to 'stub' (the safe default)", async () => {
      delete process.env.EMBEDDING_PROVIDER;
      delete process.env.RERANK_PROVIDER;
      const { pinStubProviders } = await import("./run-adapter");
      pinStubProviders();
      expect(process.env.EMBEDDING_PROVIDER).toBe("stub");
      expect(process.env.RERANK_PROVIDER).toBe("stub");
    });

    it("EMBEDDING_PROVIDER=stub passes through unchanged", async () => {
      process.env.EMBEDDING_PROVIDER = "stub";
      process.env.RERANK_PROVIDER = "stub";
      const { pinStubProviders } = await import("./run-adapter");
      expect(() => pinStubProviders()).not.toThrow();
      expect(process.env.EMBEDDING_PROVIDER).toBe("stub");
    });
  });

  describe("pipelineAdapter — DATABASE_URL guard", () => {
    it("retrieve() throws loud when DATABASE_URL is unset", async () => {
      delete process.env.DATABASE_URL;
      const { pipelineAdapter } = await import("./run-adapter");
      await expect(pipelineAdapter.retrieve("any query")).rejects.toThrow(/DATABASE_URL/);
    });
  });
});
