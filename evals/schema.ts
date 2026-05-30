// evals/schema.ts — Zod schema for evals/golden_set.yaml.
//
// Source-of-truth schema for the M3 retrieval eval set. Per ADR review M4:
// Zod is the source; JSON-Schema emission for a future Python runner (M2b)
// is deferred to that milestone.
//
// Per-case `phase` (added during M3 item 6+7 Phase A — see CHATLOG):
//   - "queued"   → Phase B will fill expected_source_ids[]; runner reports `skipped`.
//   - "ready"    → expected_source_ids[] is non-empty; runner reports `measured`.
//   - "negative" → query SHOULD return nothing (negative-result UX check);
//                  expected_source_ids[] is intentionally empty.
//
// Bumping the YAML schema: increment `version` in the YAML AND `SCHEMA_VERSION`
// below so the runner can fail-loud on schema drift between code and data.

import { z } from "zod";

export const SCHEMA_VERSION = "0.4.0";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CaseIdRegex = /^(en|he)-\d{3}$/;

export const CaseLanguage = z.enum(["en", "he"]);
export type CaseLanguage = z.infer<typeof CaseLanguage>;

export const CaseCategory = z.enum([
  "procedural",
  "diagnostic",
  "conceptual",
  "cross-lingual",
  "negative",
]);
export type CaseCategory = z.infer<typeof CaseCategory>;

export const CasePhase = z.enum(["queued", "ready", "negative"]);
export type CasePhase = z.infer<typeof CasePhase>;

const UuidV4 = z.string().regex(UUID_V4, "must be a UUID v4");

export const EvalCase = z
  .object({
    id: z.string().regex(CaseIdRegex, "id must match (en|he)-NNN"),
    query: z.string().min(1).max(500),
    language: CaseLanguage,
    category: CaseCategory,
    phase: CasePhase,
    expected_source_ids: z.array(UuidV4).default([]),
    expected_answer_contains: z.array(z.string().min(1).max(200)).optional(),
    notes: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    // expected_source_ids cardinality is gated by phase.
    if (c.phase === "ready" && c.expected_source_ids.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'phase="ready" requires non-empty expected_source_ids[]',
        path: ["expected_source_ids"],
      });
    }
    if (c.phase === "queued" && c.expected_source_ids.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'phase="queued" requires empty expected_source_ids[] (fill at Phase B)',
        path: ["expected_source_ids"],
      });
    }
    if (c.phase === "negative" && c.expected_source_ids.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'phase="negative" requires empty expected_source_ids[] (the empty set IS the expected answer)',
        path: ["expected_source_ids"],
      });
    }
    if (c.phase === "negative" && c.category !== "negative") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'phase="negative" requires category="negative"',
        path: ["category"],
      });
    }
    // Language-prefix consistency: id en-NNN must have language "en", same for he.
    const idLang = c.id.slice(0, 2);
    if (idLang !== c.language) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `id prefix "${idLang}" must match language "${c.language}"`,
        path: ["id"],
      });
    }
    // UUID dedup within a case's expected_source_ids.
    const seen = new Set<string>();
    for (const id of c.expected_source_ids) {
      const lower = id.toLowerCase();
      if (seen.has(lower)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate UUID in expected_source_ids: ${id}`,
          path: ["expected_source_ids"],
        });
      }
      seen.add(lower);
    }
  });
export type EvalCase = z.infer<typeof EvalCase>;

export const BaselineConfig = z
  .object({
    name: z.string().min(1),
    config: z
      .object({
        rerank: z.boolean(),
        hybrid_search: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const GoldenSet = z
  .object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "semver-like X.Y.Z"),
    language_split: z
      .object({
        hebrew_target: z.number().int().nonnegative(),
        english_target: z.number().int().nonnegative(),
      })
      .strict(),
    cases: z.array(EvalCase).min(1),
    metrics: z
      .object({
        recall_at_k: z
          .object({
            k: z.number().int().positive(),
            target: z.number().min(0).max(1),
          })
          .strict(),
        citation_precision: z
          .object({
            target: z.number().min(0).max(1),
          })
          .strict(),
        baseline_configs: z.array(BaselineConfig),
      })
      .strict(),
  })
  .strict()
  .superRefine((doc, ctx) => {
    // Cross-case id uniqueness — Zod arrays don't enforce element uniqueness on
    // a nested field, so do it here.
    const seen = new Map<string, number>();
    for (let i = 0; i < doc.cases.length; i++) {
      const id = doc.cases[i].id;
      const prev = seen.get(id);
      if (prev !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate case id "${id}" at cases[${i}] (first seen at cases[${prev}])`,
          path: ["cases", i, "id"],
        });
      }
      seen.set(id, i);
    }
    // Schema-version match — runner refuses to parse a YAML whose version
    // is ahead of the code, because that means new fields the schema doesn't
    // know about; behind is also a fail because Phase B may have re-shaped.
    if (doc.version !== SCHEMA_VERSION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `YAML version ${doc.version} != code SCHEMA_VERSION ${SCHEMA_VERSION}; bump both together`,
        path: ["version"],
      });
    }
  });
export type GoldenSet = z.infer<typeof GoldenSet>;
