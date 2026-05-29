// evals/run-adapter.ts — pipelineAdapter + provider-pinning guards for
// the eval runner. Split out from `evals/run.ts` so wiring-guard tests
// can import the symbols without firing `main()` at module-load.
//
// See evals/run.ts for the file-level rationale (modes, iron-rule #8
// floor, operator preconditions).

import {
  resetEmbedderForTests,
  STUB_MODEL as EMBEDDING_STUB_MODEL,
  STUB_VERSION as EMBEDDING_STUB_VERSION,
} from "@/lib/embedding";
import { resetRerankerForTests, resetSynthesizerForTests } from "@/lib/retrieval";
import { evalRetrieve, evalRetrieveWithSynth } from "@/lib/retrieval-eval";
import type { RetrievalAdapter } from "./lib";

export { EMBEDDING_STUB_MODEL, EMBEDDING_STUB_VERSION };

/**
 * True when the citation_precision leg's live-synth opt-in is enabled
 * (ADR-0012 §7 Amendment 2026-05-28). The default `npm run eval` leaves this
 * unset and stays stub-only — citation_precision reports `skipped`.
 */
export function liveSynthEnabled(): boolean {
  return process.env.EVAL_USE_LIVE_SYNTH === "1";
}

/**
 * True when the live-embed opt-in is enabled (M3 acceptance measurement,
 * ADR-0012 §7 Amendment 2026-05-29). Default `npm run eval` leaves this unset
 * and pins EMBEDDING_PROVIDER=stub. Setting it allows EMBEDDING_PROVIDER=voyage
 * and requires VOYAGE_API_KEY — the real voyage-3-large embedder runs at both
 * query time AND (for a matching corpus) the seed must have been re-run with
 * EMBEDDING_PROVIDER=voyage so chunk model+version match the query embedder.
 */
export function liveEmbedEnabled(): boolean {
  return process.env.EVAL_USE_LIVE_EMBED === "1";
}

/**
 * True when the live-rerank opt-in is enabled (ADR-0012 §7 Amendment
 * 2026-05-29). Default pins RERANK_PROVIDER=stub; setting it allows
 * RERANK_PROVIDER=voyage and requires VOYAGE_API_KEY (real rerank-2). For a
 * faithful M3 acceptance run, enable this together with EVAL_USE_LIVE_EMBED
 * and EVAL_USE_LIVE_SYNTH so embed + rerank + synth are all real.
 */
export function liveRerankEnabled(): boolean {
  return process.env.EVAL_USE_LIVE_RERANK === "1";
}

/**
 * Pin EMBEDDING_PROVIDER + RERANK_PROVIDER to "stub" when unset; reject
 * non-stub overrides loudly UNLESS the matching live opt-in is set. Resets the
 * cached embedder + reranker + synth singletons so a stale instance from a
 * prior worker (e.g. vitest) cannot leak. Iron rule #8 floor for the run path.
 *
 * Embed handling (ADR-0012 §7 Amendment 2026-05-29):
 * - Default (`EVAL_USE_LIVE_EMBED` unset): pin EMBEDDING_PROVIDER=stub; a
 *   non-stub override is REJECTED (stub corpus vs voyage query → zero ANN rows).
 * - Live opt-in (`EVAL_USE_LIVE_EMBED=1`): allow EMBEDDING_PROVIDER=voyage
 *   (default it to voyage when unset), require VOYAGE_API_KEY, reject an
 *   explicit `stub` under the flag (the silent-fake-recall trap). The corpus
 *   MUST have been re-seeded with EMBEDDING_PROVIDER=voyage so chunk
 *   model+version match the query embedder.
 *
 * Rerank handling (same Amendment): symmetric — `EVAL_USE_LIVE_RERANK=1` allows
 * RERANK_PROVIDER=voyage + requires VOYAGE_API_KEY; default pins stub.
 *
 * Synth handling (ADR-0012 §7 Amendment 2026-05-28):
 * - Default (`EVAL_USE_LIVE_SYNTH` unset): the adapter calls `evalRetrieve`,
 *   which never resolves a synth — citation_precision stays `skipped`. The
 *   synth singleton is still reset for hygiene.
 * - Live opt-in (`EVAL_USE_LIVE_SYNTH=1`): the adapter calls
 *   `evalRetrieveWithSynth`, which resolves the real synth. We require
 *   `SYNTH_PROVIDER` to be unset or `"anthropic"` and an `ANTHROPIC_API_KEY`
 *   to be present — both fail-loud. An explicit `SYNTH_PROVIDER=stub` under
 *   the live flag is REJECTED: the stub cites a sentinel UUID that fails §5
 *   validation, yielding empty citation_ids that would masquerade as a
 *   measured live run (the silent-fake-numbers trap).
 *
 * The synth singleton reset MUST happen here (the single chokepoint, before
 * the first `adapter.retrieve` → `getSynthesizer()` call) so a stub cached by
 * a prior worker cannot leak into the live path.
 */
export function pinStubProviders(): void {
  // EMBEDDING_PROVIDER: pinned to stub by default; lifted to allow "voyage"
  // under the EVAL_USE_LIVE_EMBED opt-in (M3 acceptance measurement).
  if (liveEmbedEnabled()) {
    if (process.env.EMBEDDING_PROVIDER && process.env.EMBEDDING_PROVIDER !== "voyage") {
      throw new Error(
        `EVAL_USE_LIVE_EMBED=1 requires EMBEDDING_PROVIDER unset or "voyage" ` +
          `(got "${process.env.EMBEDDING_PROVIDER}"). The live embed leg measures real ` +
          `voyage-3-large recall; a stub embedder queries with stub vectors whose ` +
          `model+version never match voyage-seeded chunks → zero ANN rows (silent ` +
          `fake recall). Re-seed with EMBEDDING_PROVIDER=voyage first.`,
      );
    }
    if (!process.env.EMBEDDING_PROVIDER) {
      process.env.EMBEDDING_PROVIDER = "voyage";
    }
    if (!process.env.VOYAGE_API_KEY) {
      throw new Error(
        `EVAL_USE_LIVE_EMBED=1 requires VOYAGE_API_KEY (the live embed leg calls real ` +
          `Voyage embeddings). Unset EVAL_USE_LIVE_EMBED to keep the default stub-only eval.`,
      );
    }
  } else if (!process.env.EMBEDDING_PROVIDER) {
    process.env.EMBEDDING_PROVIDER = "stub";
  } else if (process.env.EMBEDDING_PROVIDER !== "stub") {
    throw new Error(
      `evals/run.ts requires EMBEDDING_PROVIDER unset or "stub" ` +
        `(got "${process.env.EMBEDDING_PROVIDER}"). The eval pipeline asserts ` +
        `stub-vs-stub model+version match against seeded chunks; a mismatch ` +
        `would silently return zero ANN rows. Set EVAL_USE_LIVE_EMBED=1 to run the ` +
        `real voyage-3-large embedder (M3 acceptance measurement).`,
    );
  }

  // RERANK_PROVIDER: pinned to stub by default; lifted to allow "voyage" under
  // the EVAL_USE_LIVE_RERANK opt-in.
  if (liveRerankEnabled()) {
    if (process.env.RERANK_PROVIDER && process.env.RERANK_PROVIDER !== "voyage") {
      throw new Error(
        `EVAL_USE_LIVE_RERANK=1 requires RERANK_PROVIDER unset or "voyage" ` +
          `(got "${process.env.RERANK_PROVIDER}").`,
      );
    }
    if (!process.env.RERANK_PROVIDER) {
      process.env.RERANK_PROVIDER = "voyage";
    }
    if (!process.env.VOYAGE_API_KEY) {
      throw new Error(
        `EVAL_USE_LIVE_RERANK=1 requires VOYAGE_API_KEY (the live rerank leg calls real ` +
          `Voyage rerank-2). Unset EVAL_USE_LIVE_RERANK to keep the default stub-only eval.`,
      );
    }
  } else if (!process.env.RERANK_PROVIDER) {
    process.env.RERANK_PROVIDER = "stub";
  } else if (process.env.RERANK_PROVIDER !== "stub") {
    throw new Error(
      `evals/run.ts requires RERANK_PROVIDER unset or "stub" ` +
        `(got "${process.env.RERANK_PROVIDER}"). Set EVAL_USE_LIVE_RERANK=1 to run the ` +
        `real Voyage rerank-2 (M3 acceptance measurement).`,
    );
  }

  if (liveSynthEnabled()) {
    if (process.env.SYNTH_PROVIDER && process.env.SYNTH_PROVIDER !== "anthropic") {
      throw new Error(
        `EVAL_USE_LIVE_SYNTH=1 requires SYNTH_PROVIDER unset or "anthropic" ` +
          `(got "${process.env.SYNTH_PROVIDER}"). The live citation_precision leg ` +
          `runs the real Anthropic synth; the stub synth cites a sentinel UUID ` +
          `that fails §5 validation and yields empty citation_ids — a silent ` +
          `fake-numbers trap. See ADR-0012 §7 Amendment 2026-05-28.`,
      );
    }
    if (!process.env.SYNTH_PROVIDER) {
      process.env.SYNTH_PROVIDER = "anthropic";
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        `EVAL_USE_LIVE_SYNTH=1 requires ANTHROPIC_API_KEY (the live citation_precision ` +
          `leg calls the real Anthropic synth). Unset EVAL_USE_LIVE_SYNTH to keep the ` +
          `default stub-only eval (citation_precision reports skipped). ` +
          `See ADR-0012 §7 Amendment 2026-05-28.`,
      );
    }
  }

  resetEmbedderForTests();
  resetRerankerForTests();
  resetSynthesizerForTests();
}

/**
 * Adapter wired to the real retrieval pipeline. Calls `evalRetrieve` with
 * `role="user"` (the realistic eval target; seeded synthetic-fixture
 * entries are `sensitivity: "internal"` which `sensitivityAllowedForRole("user")`
 * permits per iron rule #6 — see `lib/auth.ts:194-195`).
 *
 * Default path: `cited_ids` is `undefined` — `evalRetrieve` omits the synth
 * stage per ADR-0012 §7, so citation_precision reports `skipped`.
 *
 * Live-synth opt-in (`EVAL_USE_LIVE_SYNTH=1`, ADR-0012 §7 Amendment
 * 2026-05-28): calls `evalRetrieveWithSynth`, which runs the real synth +
 * citation validation; `cited_ids` carries the validated citation_ids (empty
 * on any degraded / validation-failed terminal → still reported `skipped`).
 * The env preconditions are enforced once in `pinStubProviders` (fail-loud).
 */
export const pipelineAdapter: RetrievalAdapter = {
  retrieve: async (query: string) => {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is not set. The eval runner requires a Postgres connection " +
          "with seeded entries. Load .env.local (e.g., via `dotenv`) and ensure " +
          "`docker compose up -d db` is running.",
      );
    }
    if (liveSynthEnabled()) {
      const result = await evalRetrieveWithSynth(query, "user");
      return {
        retrieved_ranked: result.reranked_ids,
        cited_ids: result.citation_ids,
      };
    }
    const result = await evalRetrieve(query, "user");
    return {
      retrieved_ranked: result.reranked_ids,
      cited_ids: undefined,
    };
  },
};
