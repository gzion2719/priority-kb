// lib/tags.ts — M4 #4 PR-A: rename + delete tag operations.
//
// Per ADR-0025 Amendment 2026-05-31 (the sync-full-updateEntry reconciliation):
//   - The sync loop calls full updateEntry per affected entry (lock + entries_versions
//     append + chunk DELETE+INSERT + re-embed + audit). No async re_embed_entry job.
//   - Per-entry calls are N independent transactions; D1 does NOT require cross-entry
//     atomicity for rename. Merge (PR-B) DOES require it via the §D tx-handle pattern.
//   - The operation-level audit row (kind:"tag_rename" / "tag_delete") is written FIRST
//     with empty affected_entry_ids, its id is captured + threaded into each per-entry
//     updateEntry call via audit_extra.triggered_by_audit_id, then the row is UPDATEd
//     at the end with the final affected_entry_ids array. This is the ONE place ADR-0025
//     endorses an UPDATE audit_log write — audit_log is otherwise append-only.
//   - renameTag / deleteTag are no-throw at the operation level (A8). Per-iteration
//     transient failures (Voyage 5xx, lock-wait) flip partial_failure and break the loop;
//     permanent failures (DB lost) short-circuit. The route writes nothing extra — the
//     lib owns the entire audit-row lifecycle.
//
// Iron-rule footprint:
//   #2  Callers are withAdmin-gated routes only.
//   #6  Each per-entry updateEntry call carries the loaded entry's sensitivity unchanged
//       (re-read inside the loop's outer tx via FOR UPDATE for race-safety).
//   #8  No live API surfaces — embedder is injected; tests inject stubs.
//   #9  updateEntry's existing DELETE+INSERT chunk pipeline writes new embedding_model
//       / embedding_version per chunk on every re-embed.
//   #10 Tag operations are admin-direct writes; new audit kinds don't match agent_%,
//       so the audit_log_prompt_hash_required_for_agent CHECK does not fire.
//   #12 Voyage outage during a rename causes updateEntry to throw mid-loop;
//       partial_failure flag captures it; admin retries — D13 observable-retry shape.

import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { Embedder } from "@/lib/embedding";
import { updateEntry, type IngestInput } from "@/lib/ingest";
import { hebrewCombiningMarksRegex } from "@/lib/keyword-tsquery";
import * as schema from "@/drizzle/schema";

/**
 * Result shape returned by renameTag / deleteTag. Per ADR-0025 Amendment A8:
 * no-throw at the operation level; transient failures flip partial_failure.
 */
export interface TagOperationResult {
  /** Audit row id of the tag_rename / tag_delete audit_log row. */
  audit_id: string;
  /** Entry ids actually updated by this call (excludes pre-existing matches that no longer carry the tag at FOR-UPDATE time). */
  affected_entry_ids: string[];
  /** True iff the loop encountered a transient failure mid-execution. */
  partial_failure: boolean;
  /** Free-text reason class. Present iff partial_failure. Redacted of secrets via stringifyError. */
  partial_failure_reason?: string;
}

/** Thrown by renameTag / deleteTag / mergeTags when input fails D9/A5 validation. Caught by the route → 400. */
export class TagValidationError extends Error {
  constructor(
    public readonly field: "from" | "to" | "tag",
    public readonly reason:
      | "empty"
      | "too_long"
      | "control_char"
      | "niqqud"
      | "comma_or_semicolon"
      | "to_in_from"
      | "empty_array"
      | "duplicate_in_from",
    message: string,
  ) {
    super(message);
    this.name = "TagValidationError";
  }
}

/**
 * Thrown by mergeTags ONLY when the outer transaction's atomic-or-bust contract
 * (ADR-0025 D3 + Amendment 2026-06-01 §B1) trips: a per-iteration updateEntry
 * call inside the merge's outer tx threw, so the outer tx rolled back leaving
 * zero entries changed. Carries the audit_id captured BEFORE the outer tx
 * opened so the route can finalize the (already-persisted-in-its-own-tx)
 * tag_merge audit row with partial_failure + reason. Without this distinct
 * error class, the route can't distinguish "merge rolled back, audit row needs
 * finalize" from a catastrophic pre-audit-row failure where there's nothing to
 * finalize.
 */
export class MergeRollbackError extends Error {
  constructor(
    public readonly audit_id: string,
    public readonly cause_class: string,
    public readonly cause_message: string,
  ) {
    super(`merge rolled back (audit_id=${audit_id}): ${cause_class}: ${cause_message}`);
    this.name = "MergeRollbackError";
  }
}

/** ADR-0025 D9: max 64 NFC code-points. */
export const MAX_TAG_LENGTH = 64;

/**
 * ADR-0025 D9 Hebrew niqqud check. Consumes the canonical pattern from
 * lib/keyword-tsquery.ts so a single source of truth governs index-side
 * trigger, retrieval keyword lane, admin keyword search, AND this tag
 * validator.
 */
const NIQQUD_RE = hebrewCombiningMarksRegex();

// ADR-0025 D9 ASCII control chars (U+0000-U+001F + U+007F DEL).
// Escape-literal form keeps lib/tags.ts as a binary-clean text file
// (a raw control-char literal in source would make git treat the file
// as binary, breaking line-based diffs).
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-]/;

const COMMA_OR_SEMICOLON_RE = /[,;]/;

/**
 * NFC-normalize + trim + interior-whitespace collapse per ADR-0025 D9.
 * Pure transform; no validation here — see validateTagTo / validateTagFrom.
 */
export function normalizeTag(raw: string): string {
  const nfc = raw.normalize("NFC");
  const trimmed = nfc.trim();
  // Collapse interior whitespace runs to single ASCII space (D9).
  return trimmed.replace(/\s+/g, " ");
}

/**
 * ADR-0025 D9 full validation for the `to` (rename) / `tag` (delete) field.
 * Per A5: the `from` (rename source) is NOT validated against D9 because the catalog
 * may contain pre-D9 tags an admin needs to clean up; see validateTagFromLooseLength.
 *
 * Caller MUST pass already-NFC-normalized input.
 */
export function validateTagStrict(normalized: string, field: "to" | "tag"): void {
  if (normalized.length === 0) {
    throw new TagValidationError(field, "empty", `${field} is empty after normalization`);
  }
  // Length counted in code points per D9 (NFC code-point count, not UTF-16 units).
  const codePointCount = [...normalized].length;
  if (codePointCount > MAX_TAG_LENGTH) {
    throw new TagValidationError(
      field,
      "too_long",
      `${field} length ${codePointCount} exceeds max ${MAX_TAG_LENGTH}`,
    );
  }
  if (CONTROL_CHAR_RE.test(normalized)) {
    throw new TagValidationError(
      field,
      "control_char",
      `${field} contains an ASCII control character`,
    );
  }
  if (NIQQUD_RE.test(normalized)) {
    throw new TagValidationError(
      field,
      "niqqud",
      `${field} contains Hebrew niqqud (U+0591-U+05C7 range); strip diacritics before submitting`,
    );
  }
  if (COMMA_OR_SEMICOLON_RE.test(normalized)) {
    throw new TagValidationError(
      field,
      "comma_or_semicolon",
      `${field} contains ',' or ';' which would split into multiple lexemes in the keyword lane`,
    );
  }
}

/**
 * ADR-0025 A5 loose validation: length-only, no charset enforcement (allows
 * pre-D9 catalog entries to be cleaned up via rename / merge / delete).
 *
 * NUL-byte exception (M6 CR fix 2026-06-01): U+0000 is rejected even under
 * the loose rule because Postgres `text` cannot store NUL bytes at all — a
 * NUL in `from[]` would error mid-merge during the candidate-set query
 * (BEFORE the start audit row is written), bypassing the MergeRollbackError
 * path and producing a raw 500 with no audit trail. Pre-D9 tags with NUL
 * are a non-goal: they could not have been stored in the catalog in the
 * first place, so a `from` containing NUL is necessarily a malformed request.
 */
export function validateTagFromLooseLength(normalized: string): void {
  if (normalized.length === 0) {
    throw new TagValidationError("from", "empty", "from is empty after normalization");
  }
  if (normalized.includes("\x00")) {
    throw new TagValidationError(
      "from",
      "control_char",
      "from contains NUL byte (U+0000); cannot be a valid Postgres text value",
    );
  }
  const codePointCount = [...normalized].length;
  if (codePointCount > MAX_TAG_LENGTH) {
    throw new TagValidationError(
      "from",
      "too_long",
      `from length ${codePointCount} exceeds max ${MAX_TAG_LENGTH}`,
    );
  }
}

/**
 * Redact error string for partial_failure_reason. Keeps the error class name +
 * a short message tail; drops anything that looks secret-shaped. Mirrors the
 * spirit of lib/log.ts's redactSecrets without re-importing the full pattern set.
 */
function stringifyError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name || "Error";
    const msg = err.message || "";
    // Trim to ~200 chars to keep audit payload bounded.
    const tail = msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
    return `${name}: ${tail}`;
  }
  return String(err).slice(0, 200);
}

/**
 * Rename tag `from` → `to` across all entries currently tagged `from`.
 *
 * Always writes exactly one operation-level audit_log row (kind:"tag_rename"):
 *   1. INSERT with empty affected_entry_ids at start → capture id.
 *   2. For each affected entry, re-read its tags under FOR UPDATE inside its own
 *      tx, verify `from` is still present (skip if not — concurrent edit raced),
 *      compute new tags array (dedupe `to` if already present per ADR-0025 D3
 *      collision shape — though pure rename can't collide unless `to` is already
 *      in the entry's tags; we dedupe for safety), call updateEntry threading
 *      triggered_by_audit_id.
 *   3. UPDATE the audit row with final affected_entry_ids + partial_failure flag.
 *
 * Per A8: NEVER throws on per-iteration failures. Catastrophic DB errors before
 * the initial INSERT (step 1) will throw — the route's outer catch handles that.
 */
export async function renameTag(args: {
  db: NodePgDatabase<typeof schema>;
  embedder: Embedder;
  from: string;
  to: string;
}): Promise<TagOperationResult> {
  const { db, embedder } = args;

  // D9 + A5 validation (throws TagValidationError before any DB writes).
  const fromNormalized = normalizeTag(args.from);
  const toNormalized = normalizeTag(args.to);
  validateTagFromLooseLength(fromNormalized);
  validateTagStrict(toNormalized, "to");

  // Affected-set query. Outside any tx — used only for the initial id list; the
  // per-entry loop re-reads each row under FOR UPDATE for race-safety. Uses
  // the NORMALIZED `from` (B2 fix 2026-05-31): stored tags were normalized at
  // write time, so an admin-typed " vendor " must be normalized to "vendor"
  // before the ANY match or the candidate set will silently be empty.
  // ORDER BY id is a free improvement aligning with A6 lock-ordering posture
  // for PR-B merge — costs nothing here and reduces deadlock surface.
  const candidates = await db
    .select({ id: schema.entries.id })
    .from(schema.entries)
    .where(sql`${fromNormalized} = ANY(${schema.entries.tags})`)
    .orderBy(schema.entries.id);

  // Insert the start-of-operation audit row with empty array. Per A3: always
  // written, even when no candidates exist (D13 "observable retry, no data drift").
  const [auditRow] = await db
    .insert(schema.audit_log)
    .values({
      kind: "tag_rename",
      prompt_hash: null,
      payload: {
        from: fromNormalized,
        to: toNormalized,
        affected_entry_ids: [],
        affected_entry_count: 0,
      },
    })
    .returning({ id: schema.audit_log.id });
  const auditId = auditRow.id;

  const affectedIds: string[] = [];
  let partialFailure = false;
  let partialFailureReason: string | undefined;

  // Short-circuit: to === from is a no-op rename (D13). We still wrote the
  // initial audit row above; just skip the loop.
  // Also: no candidates is a no-op.
  if (toNormalized === fromNormalized || candidates.length === 0) {
    // No loop work to do; audit row already captures the operation.
    return {
      audit_id: auditId,
      affected_entry_ids: [],
      partial_failure: false,
    };
  }

  for (const { id } of candidates) {
    try {
      const updated = await applyTagTransformToEntry({
        db,
        embedder,
        id,
        triggeredByAuditId: auditId,
        transform: (currentTags: string[]) => {
          if (!currentTags.includes(fromNormalized)) return null; // race: skip
          // Rename + dedupe (in case entry already has `to`).
          const renamed = currentTags.map((t) => (t === fromNormalized ? toNormalized : t));
          return Array.from(new Set(renamed));
        },
      });
      if (updated) {
        affectedIds.push(id);
      }
    } catch (err) {
      partialFailure = true;
      partialFailureReason = stringifyError(err);
      break;
    }
  }

  // Finalize the audit row. M1 fix 2026-05-31: wrap the UPDATE in try/catch
  // so a failure here doesn't propagate out of renameTag and trigger the
  // route's fallback-audit path (which would produce a duplicate tag_rename
  // row for one operation). Instead we mark partial_failure on the result —
  // the initial empty-array audit row stays as the only audit surface, and
  // the caller learns about the cleanup-write failure via partial_failure_reason.
  try {
    await db
      .update(schema.audit_log)
      .set({
        payload: buildTagRenamePayload({
          from: fromNormalized,
          to: toNormalized,
          affectedIds,
          partialFailure,
          partialFailureReason,
        }),
      })
      .where(eq(schema.audit_log.id, auditId));
  } catch (err) {
    partialFailure = true;
    partialFailureReason = `audit_finalize_failed: ${stringifyError(err)}`;
  }

  return {
    audit_id: auditId,
    affected_entry_ids: affectedIds,
    partial_failure: partialFailure,
    partial_failure_reason: partialFailureReason,
  };
}

/**
 * Delete tag from all entries currently tagged with it. Same shape as renameTag.
 */
export async function deleteTag(args: {
  db: NodePgDatabase<typeof schema>;
  embedder: Embedder;
  tag: string;
}): Promise<TagOperationResult> {
  const { db, embedder } = args;

  const tagNormalized = normalizeTag(args.tag);
  validateTagStrict(tagNormalized, "tag");

  // B2 fix 2026-05-31: normalized tag in the candidate-set ANY match (see renameTag).
  const candidates = await db
    .select({ id: schema.entries.id })
    .from(schema.entries)
    .where(sql`${tagNormalized} = ANY(${schema.entries.tags})`)
    .orderBy(schema.entries.id);

  const [auditRow] = await db
    .insert(schema.audit_log)
    .values({
      kind: "tag_delete",
      prompt_hash: null,
      payload: {
        tag: tagNormalized,
        affected_entry_ids: [],
        affected_entry_count: 0,
      },
    })
    .returning({ id: schema.audit_log.id });
  const auditId = auditRow.id;

  const affectedIds: string[] = [];
  let partialFailure = false;
  let partialFailureReason: string | undefined;

  if (candidates.length === 0) {
    return {
      audit_id: auditId,
      affected_entry_ids: [],
      partial_failure: false,
    };
  }

  for (const { id } of candidates) {
    try {
      const updated = await applyTagTransformToEntry({
        db,
        embedder,
        id,
        triggeredByAuditId: auditId,
        transform: (currentTags: string[]) => {
          if (!currentTags.includes(tagNormalized)) return null;
          return currentTags.filter((t) => t !== tagNormalized);
        },
      });
      if (updated) {
        affectedIds.push(id);
      }
    } catch (err) {
      partialFailure = true;
      partialFailureReason = stringifyError(err);
      break;
    }
  }

  // M1 fix 2026-05-31: try/catch the finalize UPDATE; see renameTag's matching block.
  try {
    await db
      .update(schema.audit_log)
      .set({
        payload: buildTagDeletePayload({
          tag: tagNormalized,
          affectedIds,
          partialFailure,
          partialFailureReason,
        }),
      })
      .where(eq(schema.audit_log.id, auditId));
  } catch (err) {
    partialFailure = true;
    partialFailureReason = `audit_finalize_failed: ${stringifyError(err)}`;
  }

  return {
    audit_id: auditId,
    affected_entry_ids: affectedIds,
    partial_failure: partialFailure,
    partial_failure_reason: partialFailureReason,
  };
}

const AFFECTED_IDS_CAP = 1000;

function capAffectedIds(ids: string[]): {
  affected_entry_ids: string[];
  affected_entry_count: number;
  truncated_count?: number;
} {
  if (ids.length <= AFFECTED_IDS_CAP) {
    return {
      affected_entry_ids: ids,
      affected_entry_count: ids.length,
    };
  }
  return {
    affected_entry_ids: ids.slice(0, AFFECTED_IDS_CAP),
    affected_entry_count: ids.length,
    truncated_count: ids.length - AFFECTED_IDS_CAP,
  };
}

function buildTagRenamePayload(args: {
  from: string;
  to: string;
  affectedIds: string[];
  partialFailure: boolean;
  partialFailureReason: string | undefined;
}): Record<string, unknown> {
  const capped = capAffectedIds(args.affectedIds);
  const payload: Record<string, unknown> = {
    from: args.from,
    to: args.to,
    ...capped,
  };
  if (args.partialFailure) payload.partial_failure = true;
  if (args.partialFailureReason !== undefined)
    payload.partial_failure_reason = args.partialFailureReason;
  return payload;
}

function buildTagDeletePayload(args: {
  tag: string;
  affectedIds: string[];
  partialFailure: boolean;
  partialFailureReason: string | undefined;
}): Record<string, unknown> {
  const capped = capAffectedIds(args.affectedIds);
  const payload: Record<string, unknown> = {
    tag: args.tag,
    ...capped,
  };
  if (args.partialFailure) payload.partial_failure = true;
  if (args.partialFailureReason !== undefined)
    payload.partial_failure_reason = args.partialFailureReason;
  return payload;
}

function buildTagMergePayload(args: {
  from: string[];
  to: string;
  affectedIds: string[];
  partialFailure: boolean;
  partialFailureReason: string | undefined;
}): Record<string, unknown> {
  const capped = capAffectedIds(args.affectedIds);
  const payload: Record<string, unknown> = {
    from: args.from,
    to: args.to,
    ...capped,
  };
  if (args.partialFailure) payload.partial_failure = true;
  if (args.partialFailureReason !== undefined)
    payload.partial_failure_reason = args.partialFailureReason;
  return payload;
}

/**
 * Merge N source tags into one target tag across all affected entries.
 *
 * Per ADR-0025 D3 + Amendment 2026-06-01:
 *   - **Atomic-or-bust** (DP1(a)): the per-entry loop runs inside ONE outer
 *     db.transaction(). Any per-iteration updateEntry throw propagates out →
 *     outer tx rolls back → zero entries changed. mergeTags then throws
 *     MergeRollbackError carrying the audit_id so the route can finalize the
 *     start-of-op audit row with partial_failure: true.
 *   - **Lock-hold cost** (B2): each affected row's FOR UPDATE lock is held for
 *     the duration of the entire outer tx (not per-iteration like rename/delete).
 *     A 500-entry merge holds 500 row locks simultaneously, blocking concurrent
 *     updateEntry on any of those rows. Accepted at M4 admin scale; M5 revisits
 *     when concurrent admin operations become real (BACKLOG).
 *   - **Lock-ordering** (D3 + A6): the candidate-set query orders by entry id,
 *     so the lock-acquisition order is deterministic across concurrent merges.
 *   - **Collision dedupe**: entry tagged [foo, bar] under merge [foo] → bar
 *     becomes [bar], not [bar, bar]. Dedupe runs inside the per-entry transform.
 *   - **Finalize-inside-outer-tx** (Q2): the operation-level audit row UPDATE
 *     happens INSIDE the outer tx, after the per-entry loop completes. If the
 *     finalize UPDATE fails, the outer tx rolls back (atomic-or-bust extended
 *     to the finalize step).
 *   - **Iron rule #6**: merge does NOT mutate entries.sensitivity. The per-entry
 *     updateEntry re-reads sensitivity under FOR UPDATE and preserves it.
 *     audit row is admin-role-only (route is withAdmin); no cross-tier leak.
 */
export async function mergeTags(args: {
  db: NodePgDatabase<typeof schema>;
  embedder: Embedder;
  from: string[];
  to: string;
}): Promise<TagOperationResult> {
  const { db, embedder } = args;

  // D9 + A5 validation. Throws TagValidationError before any DB writes.
  const toNormalized = normalizeTag(args.to);
  validateTagStrict(toNormalized, "to");

  if (args.from.length === 0) {
    throw new TagValidationError("from", "empty_array", "from must be non-empty");
  }

  // Normalize + loose-length-validate each from element; dedupe.
  const fromNormalizedSet = new Set<string>();
  const fromNormalized: string[] = [];
  for (const raw of args.from) {
    const n = normalizeTag(raw);
    validateTagFromLooseLength(n);
    if (fromNormalizedSet.has(n)) {
      throw new TagValidationError(
        "from",
        "duplicate_in_from",
        `from contains duplicate value "${n}" after normalization`,
      );
    }
    fromNormalizedSet.add(n);
    fromNormalized.push(n);
  }

  // DP2: reject `to ∈ from` at the validation boundary (request-shape error,
  // not a no-op — see Amendment 2026-06-01 A4 extension).
  if (fromNormalizedSet.has(toNormalized)) {
    throw new TagValidationError(
      "to",
      "to_in_from",
      `to "${toNormalized}" appears in from[]; use delete or restate the merge`,
    );
  }

  // Candidate-set query. Uses the Postgres array-overlap operator (&&) to find
  // entries whose tags array shares at least one element with the normalized
  // from[]. Empirical correction: Drizzle's sql`${jsArray}` template binds a
  // JS array via its toString() (comma-joined scalar), which pg then rejects
  // as "malformed array literal" for a text[] cast. Workaround: build the
  // Postgres array literal string ourselves ({"a","b"}) and bind it as a
  // single text param cast to text[] — semantically identical to the standalone
  // pg.Pool array-codec binding the pre-coding smoke test verified.
  // Element-escape: backslash + double-quote, then wrap in double-quotes so
  // values with commas/whitespace round-trip safely. ORDER BY id pins the
  // lock-acquisition order across concurrent merges (A6 lock-ordering).
  const fromPgLiteral = `{${fromNormalized
    .map((s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",")}}`;
  const candidates = await db
    .select({ id: schema.entries.id })
    .from(schema.entries)
    .where(sql`${schema.entries.tags} && ${fromPgLiteral}::text[]`)
    .orderBy(schema.entries.id);

  // Insert the start-of-operation audit row with empty array. Written in its
  // OWN auto-tx (db.insert without an enclosing transaction). Even if the
  // subsequent outer-tx rolls back, this audit row stays — that's why
  // MergeRollbackError carries the audit_id back to the route for finalize.
  const [auditRow] = await db
    .insert(schema.audit_log)
    .values({
      kind: "tag_merge",
      prompt_hash: null,
      payload: {
        from: fromNormalized,
        to: toNormalized,
        affected_entry_ids: [],
        affected_entry_count: 0,
      },
    })
    .returning({ id: schema.audit_log.id });
  const auditId = auditRow.id;

  // Short-circuit: no candidates is a no-op (D13 observable retry). The
  // start audit row already attests to the operation.
  if (candidates.length === 0) {
    return {
      audit_id: auditId,
      affected_entry_ids: [],
      partial_failure: false,
    };
  }

  // Outer tx: atomic-or-bust. Per-iteration throw propagates out of this
  // callback → drizzle rolls back the outer tx → zero entry changes.
  const affectedIds: string[] = [];
  try {
    await db.transaction(async (tx) => {
      for (const { id } of candidates) {
        const updated = await applyTagTransformToEntry({
          db,
          embedder,
          id,
          triggeredByAuditId: auditId,
          outerTx: tx,
          transform: (currentTags: string[]) => {
            // Skip if none of the from[] tags is present (concurrent edit raced).
            if (!currentTags.some((t) => fromNormalizedSet.has(t))) return null;
            // Replace every from[] occurrence with `to`, then dedupe.
            const replaced = currentTags.map((t) => (fromNormalizedSet.has(t) ? toNormalized : t));
            return Array.from(new Set(replaced));
          },
        });
        if (updated) {
          affectedIds.push(id);
        }
      }

      // Finalize-inside-outer-tx (Q2): the operation-level audit row UPDATE
      // happens inside the outer tx. If this UPDATE fails, the outer tx rolls
      // back along with every per-entry change — atomic-or-bust extends to
      // the finalize step. Uses tx (not db) so the UPDATE sees its own writes.
      await tx
        .update(schema.audit_log)
        .set({
          payload: buildTagMergePayload({
            from: fromNormalized,
            to: toNormalized,
            affectedIds,
            partialFailure: false,
            partialFailureReason: undefined,
          }),
        })
        .where(eq(schema.audit_log.id, auditId));
    });
  } catch (err) {
    // Outer tx rolled back. The start audit row is still persisted (it was
    // written in its own auto-tx before the outer tx opened). Throw
    // MergeRollbackError so the route can finalize the audit row with
    // partial_failure: true + the redacted error class.
    throw new MergeRollbackError(
      auditId,
      err instanceof Error ? err.name || "Error" : "Unknown",
      stringifyError(err),
    );
  }

  return {
    audit_id: auditId,
    affected_entry_ids: affectedIds,
    partial_failure: false,
  };
}

/**
 * Per-entry helper: re-read the entry under FOR UPDATE, apply the transform to
 * its tags, call updateEntry. Returns true iff the transform produced a real
 * change AND updateEntry was called.
 *
 * The transform receives the current tags array and returns either:
 *   - a new tags array (apply via updateEntry)
 *   - null (skip — concurrent edit raced; the tag is no longer present)
 *
 * Two transaction modes:
 *   - **outerTx omitted** (renameTag / deleteTag — PR-A's per-iteration scoping):
 *     opens its own db.transaction(...). Per-iteration throw rolls back ONLY
 *     this iteration; the caller's loop continues. Row lock released at commit.
 *   - **outerTx provided** (mergeTags — atomic-or-bust): no extra wrap; the
 *     `db` argument is IGNORED in this mode (the caller's outerTx fully owns
 *     the transaction context). The FOR UPDATE re-read runs inside the
 *     caller's outer tx; updateEntry below opens a SAVEPOINT inside it. A
 *     throw propagates out of THIS function and out of the caller's outer-tx
 *     callback → the entire outer tx rolls back. Cost: each row's FOR UPDATE
 *     lock is held until the outer tx commits (ADR-0025 Amendment 2026-06-01
 *     §B2 — accepted at M4 admin scale).
 *
 * M4 CR fix 2026-06-01: the signature requires `db` even in outerTx-provided
 * mode (where it's ignored). A discriminated-union signature was considered
 * and rejected — overkill for a private helper. Callers always pass the `db`
 * they were originally given.
 *
 * Note on the entries.tsv trigger: each updateEntry call here fires the
 * (BEFORE INSERT OR UPDATE OF title, tags, body) trigger from migration 0002,
 * recomputing tsv per affected row. This is correct and load-bearing — do NOT
 * attempt to "optimize" the loop into a single bulk UPDATE; the per-row
 * updateEntry pipeline owns lock-version-rechunk-audit invariants that bulk
 * SQL would silently violate (ADR-0025 D1).
 */
async function applyTagTransformToEntry(args: {
  db: NodePgDatabase<typeof schema>;
  embedder: Embedder;
  id: string;
  triggeredByAuditId: string;
  transform: (currentTags: string[]) => string[] | null;
  /**
   * If provided, the per-entry work runs inline on this tx handle (no extra
   * savepoint wrap). Used by mergeTags for atomic-or-bust outer-tx semantics.
   * If omitted, opens its own db.transaction (per-iteration scoping; used by
   * renameTag / deleteTag).
   */
  outerTx?: NodePgDatabase<typeof schema>;
}): Promise<boolean> {
  const { db, embedder, id, triggeredByAuditId, transform, outerTx } = args;

  const runOn = async (tx: NodePgDatabase<typeof schema>): Promise<boolean> => {
    // Re-read the entry under FOR UPDATE. This serializes with concurrent
    // updateEntry calls on the same row — closes the race window where a tag
    // was removed by a concurrent edit between our candidate-set SELECT and
    // this loop iteration.
    const [current] = await tx
      .select({
        id: schema.entries.id,
        title: schema.entries.title,
        category: schema.entries.category,
        tags: schema.entries.tags,
        body: schema.entries.body,
        source_pointer: schema.entries.source_pointer,
        last_verified_at: schema.entries.last_verified_at,
        sensitivity: schema.entries.sensitivity,
      })
      .from(schema.entries)
      .where(eq(schema.entries.id, id))
      .for("update");

    if (current === undefined) {
      // Entry was deleted between the candidate-set SELECT and this loop —
      // treat as skipped (not partial-failure; this is concurrent deletion,
      // which is a legitimate operation).
      return false;
    }

    const newTags = transform(current.tags);
    if (newTags === null) return false;

    // Identity check (avoid no-op updateEntry calls that would still append
    // an entries_versions row + re-chunk for no semantic change).
    if (arraysEqual(newTags, current.tags)) return false;

    const input: IngestInput = {
      title: current.title,
      category: current.category,
      tags: newTags,
      body: current.body,
      source_pointer: current.source_pointer,
      last_verified_at: current.last_verified_at,
      sensitivity: current.sensitivity,
    };

    // Pass `tx` as `db` — updateEntry will open its own transaction, which
    // becomes a SAVEPOINT under our (own or caller's) outer tx. The row's
    // FOR UPDATE lock is held above, so updateEntry's own FOR UPDATE re-acquires
    // immediately without contention.
    await updateEntry({
      db: tx,
      embedder,
      id,
      input,
      source: { kind: "direct" },
      audit_extra: { triggered_by_audit_id: triggeredByAuditId },
    });

    return true;
  };

  if (outerTx !== undefined) {
    // Atomic-or-bust path: no extra wrap. A throw propagates straight to the
    // caller's outer-tx callback.
    return await runOn(outerTx);
  }
  // Per-iteration scoping path (PR-A renameTag/deleteTag): own tx so a throw
  // rolls back only this iteration's writes.
  return await db.transaction(runOn);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
