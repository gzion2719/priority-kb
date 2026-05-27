// evals/run.ts — CLI entry for `npm run eval` / `npm run eval:lint`.
//
// Modes:
//   - `--lint-only`: load + Zod-validate evals/golden_set.yaml. Exit 0 on
//      valid; exit 1 on schema error. No DB access, no env mutation. This
//      is the cheap mode that `npm run check` chains.
//   - Default (`npm run eval`): everything `--lint-only` does, PLUS runs
//      each case through `pipelineAdapter` — a real adapter wired to
//      `lib/retrieval-eval.ts::evalRetrieve()` per ADR-0012 §7. Requires
//      a running Postgres (DATABASE_URL) with seeded entries. Each case
//      with `phase: ready` is measured; `queued` and `negative` skip.
//      Writes evals/last-run.json with the summary and prints a human
//      table to stdout. Exit 0 unless a shape_error fired.
//
// Iron-rule #8 floor: the run-time path defensively pins EMBEDDING_PROVIDER
// and RERANK_PROVIDER to "stub" if unset, and resets the embedder + reranker
// singletons so a stale cache from a prior `npm run check` worker cannot
// leak live-API instances into eval. Synth is NOT invoked — `evalRetrieve`
// per ADR-0012 §7 omits the synth stage, so `cited_ids` returns undefined
// and citation_precision honestly reports `skipped` for every measured
// case. Citation-precision measurement is BACKLOG (driver: design choice
// between live-Anthropic-opt-in and an eval-specific stub that cites
// reranked_ids[0]).
//
// Operator preconditions (run mode only):
//   - DATABASE_URL set (e.g., .env.local loaded).
//   - Postgres running and reachable.
//   - Seed has been applied: `npx tsx scripts/seed-synthetic-entries.ts --apply`
//     (or equivalent). The runner prints a "did you seed?" hint when every
//     `ready` case returns recall=0 — the canonical symptom of an
//     unseeded DB.

import { writeFile } from "node:fs/promises";
import dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { buildSummary, loadGoldenSet, runCase, type CaseResult } from "./lib";
import {
  pipelineAdapter,
  pinStubProviders,
  EMBEDDING_STUB_MODEL,
  EMBEDDING_STUB_VERSION,
} from "./run-adapter";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

const GOLDEN_SET_PATH = "evals/golden_set.yaml";
const ARTIFACT_PATH = "evals/last-run.json";

async function main(argv: string[]): Promise<number> {
  const lintOnly = argv.includes("--lint-only");

  let goldenSet;
  try {
    goldenSet = await loadGoldenSet(GOLDEN_SET_PATH);
  } catch (e) {
    if (e instanceof z.ZodError) {
      console.error(`evals/golden_set.yaml failed schema validation:`);
      for (const issue of e.issues) {
        console.error(`  ${issue.path.join(".")}: ${issue.message}`);
      }
      return 1;
    }
    console.error(`Failed to load golden set: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  if (lintOnly) {
    console.log(
      `evals/golden_set.yaml OK (version ${goldenSet.version}, ${goldenSet.cases.length} cases)`,
    );
    return 0;
  }

  // Load .env.local FIRST (Next.js convention), then .env as fallback —
  // mirrors scripts/seed-synthetic-entries.ts so eval and seed read the
  // same connection string by default.
  dotenv.config({ path: resolve(repoRoot, ".env.local") });
  dotenv.config({ path: resolve(repoRoot, ".env") });

  pinStubProviders();

  const per_case: CaseResult[] = [];
  for (const c of goldenSet.cases) {
    per_case.push(await runCase(c, goldenSet.metrics.recall_at_k.k, pipelineAdapter));
  }

  const summary = buildSummary(per_case, goldenSet.metrics.recall_at_k.k, {
    recall_at_k: goldenSet.metrics.recall_at_k.target,
    citation_precision: goldenSet.metrics.citation_precision.target,
  });

  await writeFile(ARTIFACT_PATH, JSON.stringify(summary, null, 2) + "\n", "utf-8");

  // Human-readable summary
  console.log(`Eval run @ ${summary.ran_at}`);
  console.log(`  schema_version: ${summary.schema_version}`);
  console.log(`  k: ${summary.k}`);
  console.log(`  embedder pin:  ${EMBEDDING_STUB_MODEL} / ${EMBEDDING_STUB_VERSION}`);
  console.log(
    `  totals: ${summary.totals.cases} cases — ` +
      `${summary.totals.measured} measured, ` +
      `${summary.totals.skipped} skipped, ` +
      `${summary.totals.shape_error} shape_error`,
  );
  console.log(
    `  recall@${summary.k}_mean: ${summary.aggregate.recall_at_k_mean ?? "n/a (no measured cases)"} ` +
      `(target ${summary.targets.recall_at_k})`,
  );
  console.log(
    `  citation_precision_mean: ${summary.aggregate.citation_precision_mean ?? "n/a (skipped — synth not wired per ADR-0012 §7)"} ` +
      `(target ${summary.targets.citation_precision})`,
  );

  // "Did you seed?" hint — when every measured case scored recall=0, the
  // canonical cause is an empty `entries` table (or a model/version
  // mismatch in the ANN WHERE filter — see pinStubProviders for the
  // floor on the latter). Surface the diagnostic instead of letting
  // a zero-recall result silently look like a genuine retrieval failure.
  const measuredCases = per_case.filter((r) => r.status === "measured");
  const allMeasuredAreZero =
    measuredCases.length > 0 &&
    measuredCases.every((r) => typeof r.recall_at_k === "number" && r.recall_at_k === 0);
  if (allMeasuredAreZero) {
    console.error(
      `\nWARNING: every measured case (${measuredCases.length}) returned recall@${summary.k}=0. ` +
        `Common cause: the database has not been seeded. Run: ` +
        `npx tsx scripts/seed-synthetic-entries.ts --apply`,
    );
  }

  console.log(`  artifact: ${ARTIFACT_PATH}`);

  // shape_error is the only non-zero exit. Measured-below-target doesn't
  // fail until n ≥ 20 (per ROADMAP M3 acceptance note); below that threshold
  // the numbers are pipeline-correctness signal, not retrieval-quality
  // signal.
  return summary.totals.shape_error > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
