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
import { resetRerankerForTests } from "@/lib/retrieval";
import { evalRetrieve } from "@/lib/retrieval-eval";
import type { RetrievalAdapter } from "./lib";

export { EMBEDDING_STUB_MODEL, EMBEDDING_STUB_VERSION };

/**
 * Pin EMBEDDING_PROVIDER + RERANK_PROVIDER to "stub" when unset; reject
 * non-stub overrides loudly. Resets the cached embedder + reranker
 * singletons so a stale instance from a prior worker (e.g. vitest)
 * cannot leak. Iron rule #8 floor for the run path.
 *
 * SYNTH_PROVIDER is NOT pinned: `evalRetrieve` does not resolve a synth
 * (see `lib/retrieval-eval.ts` header), so the factory is never reached.
 */
export function pinStubProviders(): void {
  if (!process.env.EMBEDDING_PROVIDER) {
    process.env.EMBEDDING_PROVIDER = "stub";
  } else if (process.env.EMBEDDING_PROVIDER !== "stub") {
    throw new Error(
      `evals/run.ts requires EMBEDDING_PROVIDER unset or "stub" ` +
        `(got "${process.env.EMBEDDING_PROVIDER}"). The eval pipeline asserts ` +
        `stub-vs-stub model+version match against seeded chunks; a mismatch ` +
        `would silently return zero ANN rows. See docs/BACKLOG.md ` +
        `"evalRetrieveWithSynth + live-API eval" for the live-provider path.`,
    );
  }
  if (!process.env.RERANK_PROVIDER) {
    process.env.RERANK_PROVIDER = "stub";
  } else if (process.env.RERANK_PROVIDER !== "stub") {
    throw new Error(
      `evals/run.ts requires RERANK_PROVIDER unset or "stub" ` +
        `(got "${process.env.RERANK_PROVIDER}"). Live Voyage rerank is BACKLOG; ` +
        `same rationale as the embedder pin.`,
    );
  }
  resetEmbedderForTests();
  resetRerankerForTests();
}

/**
 * Adapter wired to the real retrieval pipeline. Calls `evalRetrieve` with
 * `role="user"` (the realistic eval target; seeded synthetic-fixture
 * entries are `sensitivity: "internal"` which `sensitivityAllowedForRole("user")`
 * permits per iron rule #6 — see `lib/auth.ts:194-195`).
 *
 * `cited_ids` is `undefined` by design: `evalRetrieve` omits the synth
 * stage per ADR-0012 §7. citation_precision reports as `skipped` for every
 * measured case until the BACKLOG'd `evalRetrieveWithSynth` lands.
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
    const result = await evalRetrieve(query, "user");
    return {
      retrieved_ranked: result.reranked_ids,
      cited_ids: undefined,
    };
  },
};
