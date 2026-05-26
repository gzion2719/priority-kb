// lib/jobs.ts — ADR-0019 M2b #3 Node enqueue path.
//
// The Python worker (api/jobs.py) is the consumer; this module is the
// producer. Cross-language contract: the SQL schema (drizzle/schema.ts
// `jobs` table) is the wire format. Versioned by Drizzle per ADR-0008.
//
// Iron-rule footprint (ADR-0019 §D8):
//   #2  Enqueue is callable only from `withAdmin`-gated routes; the
//       module exposes no public surface. The worker is downstream and
//       has no public surface of its own (M2b #3 has no caller wiring;
//       M2b #4 wires `/api/ingest` blob-upload).
//   #6  `payload` is rejected at write time if it contains ANY key
//       matching /sensitivity/i at any depth (recursive scan). The
//       worker re-reads `entries.sensitivity` at chunk-write time
//       (M2b #4) — a payload-borne snapshot would let a stale tier slip
//       through if the entry is re-tagged during queue dwell.
//   #9/#10 Deferred to M2b #4 per ADR-0019 §D8 — no agent invocation,
//       no embedding write here.
//   #12 Queue is independent of Claude/Voyage. Enqueue keeps working
//       when those vendors are down.

import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";

import * as schema from "@/drizzle/schema";
import { logEvent } from "@/lib/log";

/**
 * Recursive scan rejecting any key matching /sensitivity/i at any depth.
 * Returns the JSON-pointer-like path of the first offending key, or null.
 *
 * Iron-rule #6 mechanical floor per ADR-0019 §D8. The plan-CR amplification
 * (M2) extended the rejection from a top-level banned key to a recursive
 * scan because a caller could otherwise smuggle the field as
 * `meta.sensitivity` or `entry_sensitivity` and bypass a top-level check.
 *
 * Cycle guard: the `seen` WeakSet prevents stack overflow on cyclic payloads
 * (`p.self = p`). A cyclic input is structurally invalid for `jsonb`
 * insertion (JSON.stringify throws on cycles), but the Zod scan runs before
 * the INSERT — so without this guard a malformed caller crashes the request
 * with a RangeError instead of getting the documented InvalidJobPayloadError.
 * Code-CR B1 (2026-05-26).
 *
 * Symbol-keyed payload entries are silently dropped — `Object.keys` returns
 * only own enumerable string keys, and `JSON.stringify` (which `jsonb`
 * insertion uses internally) also drops symbol keys. A caller smuggling
 * `{[Symbol.for('sensitivity')]: 'restricted'}` never reaches Postgres at
 * all, so the scan's blind spot is not a real bypass surface.
 */
function findSensitivityKey(
  value: unknown,
  path = "$",
  seen: WeakSet<object> = new WeakSet(),
): string | null {
  if (value === null || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const nested = findSensitivityKey(value[i], `${path}[${i}]`, seen);
      if (nested !== null) return nested;
    }
    return null;
  }
  for (const k of Object.keys(value as Record<string, unknown>)) {
    if (/sensitivity/i.test(k)) return `${path}.${k}`;
    const nested = findSensitivityKey((value as Record<string, unknown>)[k], `${path}.${k}`, seen);
    if (nested !== null) return nested;
  }
  return null;
}

const enqueuePayloadSchema = z
  .object({})
  .passthrough()
  .superRefine((val, ctx) => {
    const found = findSensitivityKey(val);
    if (found !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `payload contains a sensitivity-shaped key at ${found}; ` +
          `jobs.payload must not carry a sensitivity snapshot (ADR-0019 §D8 ` +
          `iron-rule #6 mechanical floor — worker re-reads entries.sensitivity ` +
          `at chunk-write time, so a payload snapshot would let stale tier ` +
          `slip through if the entry is re-tagged during queue dwell).`,
      });
    }
  });

/** Input to {@link enqueueJob}. */
export interface EnqueueArgs {
  /** Logical queue name — `"ingest"`, `"ocr"`, etc. Matches `jobs.queue_name`. */
  queue: string;
  /**
   * Control-plane envelope per ADR-0019 §D5 — `entry_id`,
   * `blob_storage_path`, `content_type`, optional metadata. MUST NOT
   * contain the binary itself; blob storage is M2b #4 and the queue
   * carries the pointer only. Rejected at write time if any nested key
   * matches /sensitivity/i.
   *
   * Values MUST be JSON-serializable primitives, arrays, or plain
   * objects. Non-plain objects (`Date`, `Map`, `Set`, `RegExp`,
   * class instances) are lossy through `JSON.stringify` — `Date` becomes
   * its ISO string; `Map`/`Set` become `{}`; class instances lose their
   * prototype. Callers MUST pre-serialize anything non-plain.
   */
  payload: Record<string, unknown>;
  /**
   * Stable input descriptor for at-least-once + dedupe (ADR-0019 §D3).
   * Recommended: `sha256(blob_storage_path)` for file-upload jobs.
   * Callers that genuinely want multi-fire semantics pass a fresh UUID.
   * Length must be 1..200 chars (server-side CHECK constraint).
   */
  idempotencyKey: string;
}

/**
 * Outcome of an enqueue attempt. `created:true` means the row was inserted
 * this call; `created:false` means the idempotency key already existed
 * and the caller is observing the prior insert's state. The
 * `existingState` field lets the caller branch — e.g., re-uploading a
 * blob whose key already produced a `done` entry can surface the
 * existing result instead of waiting for a re-run that will never fire.
 *
 * Plan-CR M5: returning `existingState` instead of a bare `{created:false}`
 * resolves the "caller can't distinguish queued-will-run from
 * already-done-will-not-re-run" gap.
 */
export type EnqueueResult =
  | { id: string; created: true }
  | { id: string; created: false; existingState: schema.JobState };

/** Thrown when {@link enqueueJob} payload validation fails. */
export class InvalidJobPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJobPayloadError";
  }
}

/**
 * Enqueue a job (ADR-0019).
 *
 * At-least-once delivery semantics: the INSERT uses `ON CONFLICT
 * (idempotency_key) DO NOTHING`. The INSERT + the `audit_log` row are
 * written in the same transaction so the two rows never diverge.
 *
 * Transaction nesting: passing a `db` that is itself inside an outer
 * transaction (drizzle `db.transaction(async (tx) => enqueueJob(tx, ...))`)
 * opens a SAVEPOINT — both inserts roll back with the outer txn. This is
 * the recommended caller pattern for M2b #4 (`POST /api/ingest` will
 * wrap the entry write and the enqueue in a single outer txn so a
 * failed entry insert rolls back the enqueue too).
 *
 * @throws InvalidJobPayloadError when `payload` contains a sensitivity-shaped
 *   key at any depth.
 * @throws Error (database CHECK violation) when `idempotencyKey` length is
 *   not in 1..200.
 */
export async function enqueueJob(
  db: NodePgDatabase<typeof schema>,
  args: EnqueueArgs,
): Promise<EnqueueResult> {
  const parsed = enqueuePayloadSchema.safeParse(args.payload);
  if (!parsed.success) {
    throw new InvalidJobPayloadError(parsed.error.issues[0]?.message ?? "invalid jobs.payload");
  }

  const startedAt = performance.now();

  const result = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.jobs)
      .values({
        queue_name: args.queue,
        payload: args.payload,
        idempotency_key: args.idempotencyKey,
      })
      .onConflictDoNothing({ target: schema.jobs.idempotency_key })
      .returning({ id: schema.jobs.id });

    const first = inserted[0];
    if (first !== undefined) {
      const id = first.id;
      await tx.insert(schema.audit_log).values({
        kind: "job_enqueued",
        prompt_hash: null,
        payload: {
          queue_name: args.queue,
          job_id: id,
          idempotency_key: args.idempotencyKey,
        },
      });
      return { id, created: true as const };
    }

    // Conflict path — fetch the existing row's id + state so the caller
    // can branch. No audit_log row on conflict — `job_enqueued` is the
    // "row inserted" event, not the "enqueue call made" event.
    //
    // Empty-SELECT race (code-CR B2/B3, 2026-05-26): a concurrent
    // `scripts/cleanup-jobs.mjs` DELETE between our ON CONFLICT and our
    // SELECT, OR a winning concurrent tx that rolled back after our
    // INSERT blocked-then-returned-0-rows, can both surface as
    // "conflict returned 0 rows AND SELECT returns 0 rows." Both
    // resolve by retrying the INSERT once — the row genuinely doesn't
    // exist now, so the second INSERT will succeed without a conflict.
    const existing = await tx
      .select({ id: schema.jobs.id, state: schema.jobs.state })
      .from(schema.jobs)
      .where(eq(schema.jobs.idempotency_key, args.idempotencyKey));
    if (existing.length === 0) {
      const retry = await tx
        .insert(schema.jobs)
        .values({
          queue_name: args.queue,
          payload: args.payload,
          idempotency_key: args.idempotencyKey,
        })
        .onConflictDoNothing({ target: schema.jobs.idempotency_key })
        .returning({ id: schema.jobs.id });
      if (retry.length > 0) {
        const id = retry[0]!.id;
        await tx.insert(schema.audit_log).values({
          kind: "job_enqueued",
          prompt_hash: null,
          payload: {
            queue_name: args.queue,
            job_id: id,
            idempotency_key: args.idempotencyKey,
          },
        });
        return { id, created: true as const };
      }
      // Second attempt also saw a conflict — a third concurrent tx
      // raced. Re-SELECT one more time; if still empty, surface the
      // race honestly rather than claim unreachability.
      const second = await tx
        .select({ id: schema.jobs.id, state: schema.jobs.state })
        .from(schema.jobs)
        .where(eq(schema.jobs.idempotency_key, args.idempotencyKey));
      if (second.length === 0) {
        throw new Error(
          "enqueueJob: idempotency-key contention exceeded retry budget; caller should retry",
        );
      }
      return {
        id: second[0]!.id,
        created: false as const,
        existingState: second[0]!.state,
      };
    }
    return {
      id: existing[0]!.id,
      created: false as const,
      existingState: existing[0]!.state,
    };
  });

  // LogEvent fires only on actual insert. The conflict path is a no-op
  // from the queue's POV; observability surfaces it via `{created:false,
  // existingState}` returned to the caller.
  if (result.created) {
    logEvent({
      kind: "job",
      queue_name: args.queue,
      job_id: result.id,
      transition: "enqueued",
      latency_ms: performance.now() - startedAt,
      cost_usd: null,
      status: "ok",
    });
  }

  return result;
}
