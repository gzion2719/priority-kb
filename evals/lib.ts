// evals/lib.ts — Pure math + IO helpers for the M3 retrieval eval runner.
//
// All pure functions here are unit-tested in evals/lib.test.ts. The CLI entry
// at evals/run.ts is a thin wrapper.
//
// Phase A scope (this file):
//   - YAML load + Zod-validate against evals/schema.ts.
//   - recall@k and citation_precision math, with explicit "skipped" semantics
//     when the denominator is undefined.
//   - A `RetrievalAdapter` interface — Phase A uses a synthetic
//     in-memory implementation in tests; Phase B will swap in an adapter that
//     calls evalRetrieve() against the real pipeline (ADR-0012 §7).
//
// Per CR M2: citation_precision needs a `cited_ids[]` source, which
// evalRetrieve() per ADR-0012 §7 deliberately omits (it skips synth). The
// Phase B adapter will need either a synth-running variant (`evalRetrieveWithSynth`)
// or an alternate path; the interface below names this requirement
// explicitly so Phase B implements both methods or returns `undefined`
// for cited_ids when synth was skipped (runner reports `skipped` for
// citation_precision on that case).

import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { GoldenSet, SCHEMA_VERSION, type EvalCase } from "./schema";

export { SCHEMA_VERSION };

// ─── Math ────────────────────────────────────────────────────────────

/**
 * recall@k = |expected ∩ first-k of retrieved| / |expected|.
 *
 * Returns `undefined` when expected is empty (the "skipped" branch — aggregate
 * stats compute over `measured` only). The first-k slice is taken from the
 * front of `retrieved_ranked` (the lane's ranked output); order *inside* the
 * top-k does not affect recall, but the cutoff *at* k does.
 *
 * Per CR M1: `retrieved_ranked` is the ranked list (head = best). Dedup is
 * the caller's responsibility — the schema enforces uniqueItems on the
 * expected_source_ids side, and the runner enforces it on retrieved before
 * calling this.
 */
export function recallAtK(
  expected: readonly string[],
  retrieved_ranked: readonly string[],
  k: number,
): number | undefined {
  if (expected.length === 0) return undefined;
  if (k <= 0) throw new RangeError(`k must be positive, got ${k}`);
  const topK = retrieved_ranked.slice(0, k);
  const expectedSet = new Set(expected.map((s) => s.toLowerCase()));
  let hits = 0;
  for (const id of topK) {
    if (expectedSet.has(id.toLowerCase())) hits++;
  }
  return hits / expected.length;
}

/**
 * citation_precision = |cited ∩ expected| / |cited|.
 *
 * Returns `undefined` when:
 *   - cited is empty (no citations emitted — the "no-citation" branch), OR
 *   - cited is null/undefined (synth was skipped — the Phase B
 *     `evalRetrieveWithSynth` variant did not run).
 * Both report as `skipped` upstream; only `measured` precision values feed
 * the aggregate.
 *
 * The "expected" set here is the same expected_source_ids[] as recall — a
 * citation pointing to an entry the case names as expected counts as
 * precise.
 */
export function citationPrecision(
  expected: readonly string[],
  cited: readonly string[] | null | undefined,
): number | undefined {
  if (cited == null || cited.length === 0) return undefined;
  const expectedSet = new Set(expected.map((s) => s.toLowerCase()));
  let hits = 0;
  for (const id of cited) {
    if (expectedSet.has(id.toLowerCase())) hits++;
  }
  return hits / cited.length;
}

// ─── Per-case status ─────────────────────────────────────────────────

export type CaseStatus = "measured" | "skipped" | "shape_error";

export type CaseResult = {
  id: string;
  status: CaseStatus;
  reason?: string;
  recall_at_k?: number | undefined;
  citation_precision?: number | undefined;
};

export type EvalRunSummary = {
  schema_version: string;
  ran_at: string; // ISO timestamp
  k: number;
  totals: {
    cases: number;
    measured: number;
    skipped: number;
    shape_error: number;
  };
  aggregate: {
    recall_at_k_mean: number | null; // null when no measured cases
    citation_precision_mean: number | null;
  };
  targets: {
    recall_at_k: number;
    citation_precision: number;
  };
  per_case: CaseResult[];
};

/**
 * Synthetic mode adapter — the Phase A interface that the runner consumes.
 * Phase B will swap in an implementation that calls evalRetrieve() against
 * the real retrieval pipeline. `cited_ids` returns `undefined` to signal
 * "synth was skipped, citation_precision is unmeasurable" (the eval-only
 * path); a Phase B variant that runs synth returns the actual cited UUIDs.
 */
export interface RetrievalAdapter {
  retrieve(query: string): Promise<{
    retrieved_ranked: string[];
    cited_ids: string[] | undefined;
  }>;
}

// ─── Run a single case ───────────────────────────────────────────────

/**
 * Runs one case against the adapter. Status assignment:
 *   - "skipped" when phase is "queued" (expected is empty by schema)
 *     OR when phase is "negative" (zero-match expected; we don't measure
 *     recall on a known-empty expected set).
 *   - "measured" when phase is "ready" (expected_source_ids non-empty).
 * Per-case errors thrown by the adapter surface as "shape_error".
 *
 * Negative-result semantics are intentionally `skipped` in Phase A — once
 * the real pipeline lands, a separate metric ("negative_correctness:
 * adapter returned 0 high-confidence results for this query") can be
 * tracked. Phase A's runner does not exercise the real pipeline so it
 * can't yet assert on its silence.
 */
export async function runCase(
  c: EvalCase,
  k: number,
  adapter: RetrievalAdapter,
): Promise<CaseResult> {
  try {
    if (c.phase === "queued") {
      return {
        id: c.id,
        status: "skipped",
        reason: "queued: expected_source_ids pending Phase B fill",
      };
    }
    if (c.phase === "negative") {
      return {
        id: c.id,
        status: "skipped",
        reason: "negative: no expected entries; covered by adapter-level negative test",
      };
    }
    // phase === "ready"
    const { retrieved_ranked, cited_ids } = await adapter.retrieve(c.query);
    return {
      id: c.id,
      status: "measured",
      recall_at_k: recallAtK(c.expected_source_ids, retrieved_ranked, k),
      citation_precision: citationPrecision(c.expected_source_ids, cited_ids),
    };
  } catch (e) {
    return {
      id: c.id,
      status: "shape_error",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

// ─── Aggregate ───────────────────────────────────────────────────────

/**
 * Mean over only the `measured` cases whose metric is defined. Returns null
 * (not 0, not NaN) when no measured cases contribute — that distinguishes
 * "we ran no measurements" from "measurements averaged to zero."
 */
function meanDefined(values: (number | undefined)[]): number | null {
  const defined = values.filter((v): v is number => typeof v === "number");
  if (defined.length === 0) return null;
  return defined.reduce((s, v) => s + v, 0) / defined.length;
}

export function buildSummary(
  per_case: CaseResult[],
  k: number,
  targets: { recall_at_k: number; citation_precision: number },
): EvalRunSummary {
  const totals = {
    cases: per_case.length,
    measured: per_case.filter((r) => r.status === "measured").length,
    skipped: per_case.filter((r) => r.status === "skipped").length,
    shape_error: per_case.filter((r) => r.status === "shape_error").length,
  };
  return {
    schema_version: SCHEMA_VERSION,
    ran_at: new Date().toISOString(),
    k,
    totals,
    aggregate: {
      recall_at_k_mean: meanDefined(per_case.map((r) => r.recall_at_k)),
      citation_precision_mean: meanDefined(per_case.map((r) => r.citation_precision)),
    },
    targets,
    per_case,
  };
}

// ─── IO ──────────────────────────────────────────────────────────────

export async function loadGoldenSet(path: string): Promise<GoldenSet> {
  const raw = await readFile(path, "utf-8");
  const parsed = parseYaml(raw);
  return GoldenSet.parse(parsed);
}
