// lib/ingest.ts — M2a item 4 orchestration: scrub → normalize → chunk →
// embedBatch → transactional write (entries + entries_versions + chunks +
// audit_log). Pure orchestration; route layer owns request parsing /
// validation / response shape.
//
// Iron-rule footprint:
//   #2  writes go through this entry point (the route is its only caller).
//   #6  caller is required to pass `sensitivity` from a validated enum.
//   #8  no live API calls — embedder is injected; tests pass the stub.
//   #9  embedding_model + embedding_version columns are written from the
//       embedder's batch result, not invented.
//   #10 N/A this slice — kind:"ingest" does not match `agent_%` in the
//       audit_log CHECK. The agent-prompt path (M2a item 2) will use
//       kind:"agent_ingest" + prompt_hash; see BACKLOG.
//
// Ordering invariants (load-bearing; do not reorder without re-reading
// ADR-0009 §5 + §4):
//   1. Scrub runs FIRST — the body that lands in `entries.body` is the
//      post-scrub canonical text. No `body_raw` column exists.
//   2. NFC normalization runs SECOND — `chunk()` normalizes internally;
//      `entries.body` must hold the same normalized string so chunk
//      offsets index into the stored body.
//   3. `chunk()` THIRD — operates on the post-scrub, NFC-normalized body.
//   4. `embedBatch` is called ONCE with all chunk inputs (Voyage is batch-
//      shaped per ADR-0009 §2). Per-chunk calls would inflate cost N×.
//   5. All four inserts run inside a single Drizzle transaction. The
//      composite FK on chunks(entry_id, sensitivity) requires the entries
//      row to exist first; sensitivity propagates from the parent.

import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { CHUNKING_POLICY_VERSION, buildEmbedInput, chunk, type ChunkSlice } from "@/lib/chunk";
import type { Embedder } from "@/lib/embedding";
import { logEvent } from "@/lib/log";
import { scrubPii } from "@/lib/scrub";
import * as schema from "@/drizzle/schema";
import type { Sensitivity } from "@/drizzle/schema";

/** Input shape for `createEntry`. Route layer validates → passes here. */
export type IngestInput = {
  title: string;
  category: string;
  tags: string[];
  body: string;
  source_pointer: string;
  /** Must be a real Date (route layer parses ISO 8601 with offset). */
  last_verified_at: Date;
  sensitivity: Sensitivity;
};

export type IngestResult = {
  id: string;
  version_no: number;
  chunk_count: number;
};

/** Thrown when post-scrub body is empty (entire body was PII). */
export class EmptyBodyAfterScrubError extends Error {
  constructor() {
    super("body is empty after PII scrub — refusing to create entry");
    this.name = "EmptyBodyAfterScrubError";
  }
}

/**
 * Create a new entry (and its version_no=1 row + chunks + audit row).
 *
 * The deferred update path (next session) will append entries_versions
 * with `version_no = MAX + 1` and re-derive chunks. Because the natural
 * race is two concurrent updates colliding on `version_no`, that path
 * will need `SELECT ... FOR UPDATE` on the entries row (or a unique-
 * violation retry). Not relevant on create — UUID PK guarantees uniqueness.
 */
export async function createEntry(args: {
  db: NodePgDatabase<typeof schema>;
  embedder: Embedder;
  input: IngestInput;
}): Promise<IngestResult> {
  const { db, embedder, input } = args;

  // Step 1+2: scrub then NFC-normalize. Order is load-bearing per the
  // header invariants above.
  const scrubbed = scrubPii(input.body);
  if (scrubbed.length === 0) throw new EmptyBodyAfterScrubError();
  const canonicalBody = scrubbed.normalize("NFC");

  // Step 3: chunk against the canonical body. `chunk()` normalizes to NFC
  // internally too; passing an already-NFC string makes its work a no-op
  // but keeps the offset invariant explicit at this layer.
  const slices: ChunkSlice[] = chunk(canonicalBody);

  // Step 4: build embed inputs and batch-embed in ONE call.
  const embedInputs = slices.map((s) =>
    buildEmbedInput({
      title: input.title,
      tags: input.tags,
      body: canonicalBody,
      content_start: s.content_start,
      content_end: s.content_end,
    }),
  );

  const t0 = Date.now();
  let embedResult;
  try {
    embedResult = await embedder.embedBatch(embedInputs);
  } catch (err) {
    logEvent({
      kind: "voyage",
      model: embedder.model,
      model_version: embedder.version,
      latency_ms: Date.now() - t0,
      cost_usd: null,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  logEvent({
    kind: "voyage",
    model: embedResult.model,
    model_version: embedResult.version,
    tokens: { total: embedResult.tokens_used },
    latency_ms: Date.now() - t0,
    cost_usd: null,
    status: "ok",
  });

  if (embedResult.vectors.length !== slices.length) {
    throw new Error(
      `embedder returned ${embedResult.vectors.length} vectors for ${slices.length} slices`,
    );
  }

  // Step 5: single transaction.
  return await db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(schema.entries)
      .values({
        title: input.title,
        category: input.category,
        tags: input.tags,
        body: canonicalBody,
        source_pointer: input.source_pointer,
        last_verified_at: input.last_verified_at,
        sensitivity: input.sensitivity,
      })
      .returning({ id: schema.entries.id });

    await tx.insert(schema.entries_versions).values({
      entry_id: entry.id,
      version_no: 1,
      title: input.title,
      category: input.category,
      tags: input.tags,
      body: canonicalBody,
      sensitivity: input.sensitivity,
    });

    if (slices.length > 0) {
      const chunkRows = slices.map((s, i) => ({
        entry_id: entry.id,
        sensitivity: input.sensitivity,
        chunk_index: s.chunk_index,
        chunk_total: s.chunk_total,
        content_start: s.content_start,
        content_end: s.content_end,
        token_count: s.token_count,
        chunking_policy_version: s.chunking_policy_version,
        embedding: embedResult.vectors[i],
        embedding_model: embedResult.model,
        embedding_version: embedResult.version,
      }));
      await tx.insert(schema.chunks).values(chunkRows);
    }

    await tx.insert(schema.audit_log).values({
      kind: "ingest",
      entry_id: entry.id,
      payload: {
        chunk_count: slices.length,
        embedding_model: embedResult.model,
        embedding_version: embedResult.version,
        chunking_policy_version: CHUNKING_POLICY_VERSION,
      },
    });

    return {
      id: entry.id,
      version_no: 1,
      chunk_count: slices.length,
    };
  });
}
