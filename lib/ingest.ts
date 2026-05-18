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
//   #10 covered for agent path — when `source.kind === "agent"`, the
//       audit row carries `kind:"agent_ingest"` + `prompt_hash` read
//       from `lib/prompts` (never accepted from the caller). The DB
//       CHECK `audit_log_prompt_hash_required_for_agent` enforces
//       non-null hash at the storage boundary. For the direct path
//       (`source` omitted or `{kind:"direct"}`), kind stays `"ingest"`
//       and the CHECK does not fire because the kind doesn't match
//       `agent_%`.
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

import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { CHUNKING_POLICY_VERSION, buildEmbedInput, chunk, type ChunkSlice } from "@/lib/chunk";
import type { Embedder } from "@/lib/embedding";
import { logEvent } from "@/lib/log";
import { INGESTION_AGENT_PROMPT_HASH } from "@/lib/prompts";
import { scrubPii } from "@/lib/scrub";
import * as schema from "@/drizzle/schema";
import type { Sensitivity } from "@/drizzle/schema";

/**
 * Discriminator for the audit-log path. Default (`{kind:"direct"}` or
 * omitted) keeps the existing `"ingest"` / `"ingest_update"` shape with
 * null `prompt_hash`. `{kind:"agent"}` flips to `"agent_ingest"` /
 * `"agent_ingest_update"` and pins the audit row's `prompt_hash` to
 * `INGESTION_AGENT_PROMPT_HASH` from `lib/prompts` — the caller never
 * supplies the hash, which is the mechanical floor for iron rule #10
 * (caller-supplied hash would let a stale or wrong value slip through).
 */
export type IngestSource = { kind: "direct" } | { kind: "agent" };

type AuditKind = "ingest" | "ingest_update" | "agent_ingest" | "agent_ingest_update";

/** Resolves the audit-row shape from a source discriminator. */
function auditShapeFor(
  source: IngestSource,
  base: "ingest" | "ingest_update",
): { kind: AuditKind; prompt_hash: string | null; source_kind: "direct" | "agent" } {
  if (source.kind === "agent") {
    return {
      kind: base === "ingest" ? "agent_ingest" : "agent_ingest_update",
      prompt_hash: INGESTION_AGENT_PROMPT_HASH,
      source_kind: "agent",
    };
  }
  return { kind: base, prompt_hash: null, source_kind: "direct" };
}

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

/** Thrown by `updateEntry` when the target entry id does not exist. */
export class EntryNotFoundError extends Error {
  constructor(id: string) {
    super(`entry not found: ${id}`);
    this.name = "EntryNotFoundError";
  }
}

/**
 * Shared scrub + NFC + chunk + embedBatch pipeline used by both create and
 * update. Returns the canonical body + chunk slices + embed result. Throws
 * `EmptyBodyAfterScrubError` if the body is empty post-scrub. Emits a
 * `logEvent` on both success and failure paths (iron rule #9 lives here).
 */
async function deriveChunksAndEmbeddings(
  embedder: Embedder,
  rawBody: string,
  title: string,
  tags: string[],
): Promise<{
  canonicalBody: string;
  slices: ChunkSlice[];
  vectors: number[][];
  embedModel: string;
  embedVersion: string;
  tokensUsed: number;
}> {
  const scrubbed = scrubPii(rawBody);
  if (scrubbed.length === 0) throw new EmptyBodyAfterScrubError();
  const canonicalBody = scrubbed.normalize("NFC");

  const slices = chunk(canonicalBody);

  const embedInputs = slices.map((s) =>
    buildEmbedInput({
      title,
      tags,
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

  return {
    canonicalBody,
    slices,
    vectors: embedResult.vectors,
    embedModel: embedResult.model,
    embedVersion: embedResult.version,
    tokensUsed: embedResult.tokens_used,
  };
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
  /**
   * REQUIRED. Distinguishes direct-API ingests from agent-chat ingests.
   * Made required (vs optional with a `direct` default) so a forgetful
   * future agent caller cannot silently degrade to the direct path and
   * land an audit row without `prompt_hash` — that would satisfy the DB
   * CHECK (because `kind:"ingest"` doesn't match `agent_%`) but break
   * iron rule #10 (the agent response wouldn't be tied to its prompt).
   * Pick at the call site, type-checker won't let you forget.
   */
  source: IngestSource;
}): Promise<IngestResult> {
  const { db, embedder, input, source } = args;
  const audit = auditShapeFor(source, "ingest");

  // Steps 1–4 (scrub → NFC → chunk → embedBatch) run BEFORE the transaction
  // opens. `deriveChunksAndEmbeddings` throws `EmptyBodyAfterScrubError`
  // pre-tx so a 400 surfaces without a wasted BEGIN.
  const derived = await deriveChunksAndEmbeddings(embedder, input.body, input.title, input.tags);

  // Step 5: single transaction.
  return await db.transaction(async (tx) => {
    const [entry] = await tx
      .insert(schema.entries)
      .values({
        title: input.title,
        category: input.category,
        tags: input.tags,
        body: derived.canonicalBody,
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
      body: derived.canonicalBody,
      sensitivity: input.sensitivity,
    });

    if (derived.slices.length > 0) {
      const chunkRows = derived.slices.map((s, i) => ({
        entry_id: entry.id,
        sensitivity: input.sensitivity,
        chunk_index: s.chunk_index,
        chunk_total: s.chunk_total,
        content_start: s.content_start,
        content_end: s.content_end,
        token_count: s.token_count,
        chunking_policy_version: s.chunking_policy_version,
        embedding: derived.vectors[i],
        embedding_model: derived.embedModel,
        embedding_version: derived.embedVersion,
      }));
      await tx.insert(schema.chunks).values(chunkRows);
    }

    await tx.insert(schema.audit_log).values({
      kind: audit.kind,
      entry_id: entry.id,
      prompt_hash: audit.prompt_hash,
      payload: {
        source: audit.source_kind,
        chunk_count: derived.slices.length,
        embedding_model: derived.embedModel,
        embedding_version: derived.embedVersion,
        chunking_policy_version: CHUNKING_POLICY_VERSION,
      },
    });

    return {
      id: entry.id,
      version_no: 1,
      chunk_count: derived.slices.length,
    };
  });
}

/**
 * Update an existing entry. Appends a new `entries_versions` row with
 * `version_no = MAX+1`, updates `entries`, deletes the old `chunks` rows,
 * re-derives + inserts new chunks, writes an `audit_log` row with
 * `kind:"ingest_update"`.
 *
 * Iron-rule footprint mirrors `createEntry` above:
 *   #2  writes go through this entry point (the route is its only caller).
 *   #4  caller (route) gates admin via `withAdmin`.
 *   #6  caller is required to pass `sensitivity` from a validated enum.
 *   #8  no live API calls — embedder is injected.
 *   #9  embedding_model + embedding_version columns rewritten per chunk.
 *   #10 covered for agent path — when `source.kind === "agent"`, the
 *       audit row carries `kind:"agent_ingest_update"` + `prompt_hash`
 *       from `lib/prompts`. Direct path keeps `kind:"ingest_update"`
 *       + null hash (does not match `agent_%`, CHECK does not fire).
 *
 * Concurrency contract:
 *   - Under READ COMMITTED, two concurrent `updateEntry` calls both reach
 *     `SELECT ... FOR UPDATE` on the same entries row; the second blocks
 *     until the first commits. The MAX(version_no) read in step 2 then
 *     runs in a fresh statement-level snapshot AFTER the lock acquires,
 *     so tx2 sees tx1's committed entries_versions row and writes MAX+1.
 *   - The lock protects against concurrent updateEntry callers ONLY.
 *     Any future writer of entries_versions that does NOT acquire the
 *     same entries-row lock (e.g. a future migration script or a
 *     direct-SQL fix-up) can race. The
 *     `entries_versions_entry_id_version_no_uq` UNIQUE constraint is the
 *     backstop — a racer's INSERT would 23505 and the failing
 *     transaction rolls back.
 *   - FOR UPDATE is row-level pessimistic locking compatible with READ
 *     COMMITTED (not isolation escalation). Per ADR-0009 §7.
 *
 * Step ordering inside the tx:
 *   1. SELECT entries WHERE id=$1 FOR UPDATE  → 404 if missing
 *   2. SELECT MAX(version_no) FROM entries_versions WHERE entry_id=$1
 *   3. INSERT entries_versions (version_no = MAX+1, new snapshot)
 *   4. DELETE chunks WHERE entry_id=$1
 *   5. UPDATE entries SET ... (sensitivity change CASCADEs nothing
 *      because step 4 already removed all chunk rows that referenced it)
 *   6. INSERT new chunk rows (with the NEW sensitivity)
 *   7. INSERT audit_log row
 *
 * Step 4 BEFORE step 5 is intentional: if sensitivity changes, the
 * composite FK chunks(entry_id, sensitivity) → entries(id, sensitivity)
 * ON UPDATE CASCADE would otherwise rewrite every old chunk row's
 * sensitivity immediately before we delete them — wasted work.
 *
 * The version snapshot row stored in `entries_versions` carries the NEW
 * state (matching `createEntry`'s version_no=1 convention: the latest
 * version_no row IS the current state). `source_pointer` and
 * `last_verified_at` are NOT snapshotted — the current schema does not
 * include those columns on `entries_versions`. See BACKLOG for the
 * provenance-snapshot extension.
 */
export async function updateEntry(args: {
  db: NodePgDatabase<typeof schema>;
  embedder: Embedder;
  id: string;
  input: IngestInput;
  /** REQUIRED. See `createEntry` doc-comment for the rationale. */
  source: IngestSource;
}): Promise<IngestResult> {
  const { db, embedder, id, input, source } = args;
  const audit = auditShapeFor(source, "ingest_update");

  // Pre-tx: scrub + chunk + embed. Throws `EmptyBodyAfterScrubError`
  // before any DB work happens so a 400 surfaces without a wasted BEGIN.
  const derived = await deriveChunksAndEmbeddings(embedder, input.body, input.title, input.tags);

  return await db.transaction(async (tx) => {
    // Step 1: pessimistic lock on the entries row. Drizzle's `.for("update")`
    // emits `FOR UPDATE` on the SELECT. If the row doesn't exist, the
    // result array is empty — no rows are locked, and we throw 404.
    const locked = await tx
      .select({ id: schema.entries.id })
      .from(schema.entries)
      .where(eq(schema.entries.id, id))
      .for("update");
    if (locked.length === 0) throw new EntryNotFoundError(id);

    // Step 2: compute next version_no.
    const [maxRow] = await tx
      .select({ max: sql<number | null>`MAX(${schema.entries_versions.version_no})` })
      .from(schema.entries_versions)
      .where(eq(schema.entries_versions.entry_id, id));
    const nextVersionNo = (maxRow.max ?? 0) + 1;

    // Step 3: append the version snapshot (NEW state).
    await tx.insert(schema.entries_versions).values({
      entry_id: id,
      version_no: nextVersionNo,
      title: input.title,
      category: input.category,
      tags: input.tags,
      body: derived.canonicalBody,
      sensitivity: input.sensitivity,
    });

    // Step 4: delete old chunks BEFORE updating entries.sensitivity —
    // avoids wasted CASCADE work when sensitivity changes.
    await tx.delete(schema.chunks).where(eq(schema.chunks.entry_id, id));

    // Step 5: update the entries row. updated_at auto-bumps via the
    // BEFORE UPDATE trigger from migration 0001.
    await tx
      .update(schema.entries)
      .set({
        title: input.title,
        category: input.category,
        tags: input.tags,
        body: derived.canonicalBody,
        source_pointer: input.source_pointer,
        last_verified_at: input.last_verified_at,
        sensitivity: input.sensitivity,
      })
      .where(eq(schema.entries.id, id));

    // Step 6: insert new chunks (with NEW sensitivity).
    if (derived.slices.length > 0) {
      const chunkRows = derived.slices.map((s, i) => ({
        entry_id: id,
        sensitivity: input.sensitivity,
        chunk_index: s.chunk_index,
        chunk_total: s.chunk_total,
        content_start: s.content_start,
        content_end: s.content_end,
        token_count: s.token_count,
        chunking_policy_version: s.chunking_policy_version,
        embedding: derived.vectors[i],
        embedding_model: derived.embedModel,
        embedding_version: derived.embedVersion,
      }));
      await tx.insert(schema.chunks).values(chunkRows);
    }

    // Step 7: audit row.
    await tx.insert(schema.audit_log).values({
      kind: audit.kind,
      entry_id: id,
      prompt_hash: audit.prompt_hash,
      payload: {
        source: audit.source_kind,
        version_no: nextVersionNo,
        chunk_count: derived.slices.length,
        embedding_model: derived.embedModel,
        embedding_version: derived.embedVersion,
        chunking_policy_version: CHUNKING_POLICY_VERSION,
      },
    });

    return {
      id,
      version_no: nextVersionNo,
      chunk_count: derived.slices.length,
    };
  });
}

// Agent-path wrappers (ADR-0010 §2). The agent route's `submit_entry`
// tool handler MUST call one of these — never `createEntry` /
// `updateEntry` directly with a hand-supplied source. The `Omit<...,
// "source">` parameter shape is the compile-time mechanical floor:
// a future maintainer who copies the route shape from
// `app/api/ingest/route.ts` (which uses `source: { kind: "direct" }`)
// can't ship the agent path through the direct audit shape — TS rejects
// the extra `source` argument.
//
// Spread order matters: `source` comes LAST so even an `as any` cast
// that smuggles a `source` field through `Omit` gets overridden.

export async function submitEntryFromAgent(
  args: Omit<Parameters<typeof createEntry>[0], "source">,
): Promise<IngestResult> {
  return createEntry({ ...args, source: { kind: "agent" } as const });
}

export async function updateEntryFromAgent(
  id: string,
  args: Omit<Parameters<typeof updateEntry>[0], "source" | "id">,
): Promise<IngestResult> {
  return updateEntry({ id, ...args, source: { kind: "agent" } as const });
}
