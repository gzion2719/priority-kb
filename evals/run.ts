// evals/run.ts — CLI entry for `npm run eval` / `npm run eval:lint`.
//
// Phase A behavior (this file):
//   - `--lint-only` mode: load + Zod-validate evals/golden_set.yaml. Exit 0 on
//      valid; exit 1 on schema error. This is the cheap mode that
//      `npm run check` chains.
//   - Default mode (`npm run eval`): everything `--lint-only` does, PLUS
//      runs each case through a `RetrievalAdapter`. Phase A's adapter is
//      a NULL adapter: it never executes because every case has phase=queued
//      or phase=negative, so every case reports `skipped`. The runner
//      writes evals/last-run.json with the summary and prints a human
//      table to stdout. Exit 0 unless a shape_error fired (Phase A keeps
//      "measured below target" non-fatal — there's nothing to measure yet).
//
// Phase B (future): the null adapter is replaced with an adapter that calls
// the real evalRetrieve()/evalRetrieveWithSynth() helpers per ADR-0012 §7.

import { writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  buildSummary,
  loadGoldenSet,
  runCase,
  type CaseResult,
  type RetrievalAdapter,
} from "./lib";

const GOLDEN_SET_PATH = "evals/golden_set.yaml";
const ARTIFACT_PATH = "evals/last-run.json";

/** Phase A: never invoked. Throws loudly if the adapter is reached. */
const nullAdapter: RetrievalAdapter = {
  retrieve: async (_query: string) => {
    throw new Error(
      "Phase A: the null RetrievalAdapter was invoked, but every Phase A case " +
        "is phase=queued or phase=negative and should report `skipped` before " +
        "reaching the adapter. This is a bug — investigate runCase().",
    );
  },
};

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

  const per_case: CaseResult[] = [];
  for (const c of goldenSet.cases) {
    per_case.push(await runCase(c, goldenSet.metrics.recall_at_k.k, nullAdapter));
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
    `  citation_precision_mean: ${summary.aggregate.citation_precision_mean ?? "n/a (no measured cases)"} ` +
      `(target ${summary.targets.citation_precision})`,
  );
  console.log(`  artifact: ${ARTIFACT_PATH}`);

  // Phase A: shape_error is the only non-zero exit. Measured-below-target
  // doesn't fail until Phase B has real cases to measure.
  return summary.totals.shape_error > 0 ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
