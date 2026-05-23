// lib/retrieval-eval.ts — internal-only retrieval entry point for the evals
// runner (M3 items 6-7; ADR-0012 §7 + ADR-0013 §2.5).
//
// Calls `retrievePipeline` with `synth` omitted — the orchestrator runs
// stages A → B/B' → fuse → rerank then returns without invoking synthesis,
// citation validation, or emitting `answer_delta`/`done`/`chunks_only`.
// Projects the orchestrator's `AuditOutcome` to {@link EvalRetrieveResult}
// per the ADR-0013 §2.5 type skeleton.
//
// Why not call the route: the route is HTTP+SSE; the eval runner is a CLI
// that wants direct function-call semantics (assert on result, repeat per
// golden-set entry). The single-code-path discipline (eval reuses the
// orchestrator's stages A-C verbatim) makes a regression in production
// stages also fail the eval — drift prevention.
//
// Iron rule #8: this module imports the same provider singletons the route
// does. Eval runs in CI/tests with `RERANK_PROVIDER=stub` (no live Voyage
// call) per ADR-0012 §7. Live-API eval is a separate, manually-run smoke
// session per ADR-0011 repo-visibility constraints.

import { getEmbedder } from "@/lib/embedding";
import { getReranker } from "@/lib/retrieval";
import { type Role } from "@/lib/auth";
import {
  drainPipeline,
  retrievePipeline,
  type AuditOutcome,
  type PipelineDeps,
} from "@/lib/retrieval-pipeline";
import type { EvalRetrieveResult } from "@/lib/retrieval";

/**
 * Run retrieval against `query` for `role` and return the four lane-id arrays
 * the eval runner needs to compute recall@5 / citation-precision. Skips
 * stage D (synth) per ADR-0012 §7 — recall@5 / citation precision are
 * computed against `reranked_ids[]` which is the same set regardless of
 * whether synth ran.
 *
 * Resolves the embedder + reranker singletons internally so the eval runner
 * doesn't have to construct a {@link PipelineDeps} bundle. `synth` is NOT
 * resolved — passing `undefined` keeps `getSynthesizer()` un-called, which
 * matters when `SYNTH_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` is unset
 * in the eval environment (factory would throw `RangeError`, killing the
 * eval pre-run).
 *
 * On embed-fail the result's `ann_candidate_ids` and `fused_candidate_ids`
 * are `[]`; `keyword_candidate_ids` and `reranked_ids` reflect the
 * keyword-only path. On both-lanes-empty under embed-outage all four arrays
 * are `[]`.
 *
 * @param deps Optional override for the resolved singletons + DB helpers,
 *             used by tests to inject stub providers/lane fns without
 *             touching `globalThis` singletons.
 */
export async function evalRetrieve(
  query: string,
  role: Role,
  deps?: Partial<Omit<PipelineDeps, "synth">>,
): Promise<EvalRetrieveResult> {
  const resolvedDeps: PipelineDeps = {
    embedder: deps?.embedder ?? getEmbedder(),
    reranker: deps?.reranker ?? getReranker(),
    // synth INTENTIONALLY OMITTED — see file header.
    ...(deps?.annFn ? { annFn: deps.annFn } : {}),
    ...(deps?.keywordFn ? { keywordFn: deps.keywordFn } : {}),
    ...(deps?.getPool ? { getPool: deps.getPool } : {}),
    ...(deps?.fetchEntriesFn ? { fetchEntriesFn: deps.fetchEntriesFn } : {}),
    ...(deps?.fetchChunkSlicesFn ? { fetchChunkSlicesFn: deps.fetchChunkSlicesFn } : {}),
  };

  // drainPipeline collects all yielded events (including the pre-rerank
  // `candidates` event) into `events`; eval discards them via destructuring
  // — only the terminal `outcome` carries the recall@5 / citation-precision
  // signal. Documenting here because the file header's "no events past
  // `candidates`" line refers to what the ORCHESTRATOR emits, not what eval
  // observes.
  const gen = retrievePipeline(resolvedDeps, { query, role });
  const { outcome } = await drainPipeline(gen);
  return projectToEvalResult(outcome);
}

/**
 * Project an {@link AuditOutcome} to the {@link EvalRetrieveResult} shape.
 * Exported for unit tests that drive the orchestrator directly and want to
 * exercise the same projection without going through `evalRetrieve`'s
 * singleton resolution.
 */
export function projectToEvalResult(outcome: AuditOutcome): EvalRetrieveResult {
  return {
    ann_candidate_ids: outcome.ann_candidate_ids,
    keyword_candidate_ids: outcome.keyword_candidate_ids,
    fused_candidate_ids: outcome.fused_ids,
    reranked_ids: outcome.reranked_ids,
  };
}
