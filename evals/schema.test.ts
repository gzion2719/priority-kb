// evals/schema.test.ts — Negative-assertion tests for the Zod schema.
//
// Per WORKFLOW.md: each rejection must be distinguishable from "happy path
// accidentally rejecting." Each test constructs a base-valid doc, mutates
// one field, and asserts the failure path names the exact constraint.

import { describe, it, expect } from "vitest";
import { GoldenSet, SCHEMA_VERSION, EvalCase } from "./schema";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

const validCase = {
  id: "en-001",
  query: "How do I X?",
  language: "en" as const,
  category: "procedural" as const,
  phase: "queued" as const,
  expected_source_ids: [],
};

function makeDoc(overrides: Partial<typeof validCase>[] = []): unknown {
  const cases: unknown[] =
    overrides.length > 0 ? overrides.map((o) => ({ ...validCase, ...o })) : [validCase];
  return {
    version: SCHEMA_VERSION,
    language_split: { hebrew_target: 0, english_target: 1 },
    cases,
    metrics: {
      recall_at_k: { k: 5, target: 0.8 },
      citation_precision: { target: 0.9 },
      baseline_configs: [],
    },
  };
}

const validDoc = makeDoc();

describe("EvalCase schema", () => {
  it("accepts a valid queued case", () => {
    expect(() => EvalCase.parse(validCase)).not.toThrow();
  });

  it('rejects phase="ready" with empty expected_source_ids', () => {
    const result = EvalCase.safeParse({ ...validCase, phase: "ready", expected_source_ids: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => /phase="ready" requires non-empty/.test(i.message)),
      ).toBe(true);
    }
  });

  it('rejects phase="queued" with non-empty expected_source_ids', () => {
    const result = EvalCase.safeParse({
      ...validCase,
      phase: "queued",
      expected_source_ids: [UUID_A],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /phase="queued" requires empty/.test(i.message))).toBe(
        true,
      );
    }
  });

  it('rejects phase="negative" with non-empty expected_source_ids', () => {
    const result = EvalCase.safeParse({
      ...validCase,
      category: "negative",
      phase: "negative",
      expected_source_ids: [UUID_A],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => /phase="negative" requires empty/.test(i.message)),
      ).toBe(true);
    }
  });

  it('rejects phase="negative" with non-negative category', () => {
    const result = EvalCase.safeParse({
      ...validCase,
      category: "procedural",
      phase: "negative",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          /phase="negative" requires category="negative"/.test(i.message),
        ),
      ).toBe(true);
    }
  });

  it("rejects id prefix not matching language", () => {
    const result = EvalCase.safeParse({ ...validCase, id: "he-001", language: "en" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => /id prefix "he" must match language "en"/.test(i.message)),
      ).toBe(true);
    }
  });

  it("rejects malformed UUIDs", () => {
    const result = EvalCase.safeParse({
      ...validCase,
      phase: "ready",
      expected_source_ids: ["not-a-uuid"],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate UUIDs within expected_source_ids", () => {
    const result = EvalCase.safeParse({
      ...validCase,
      phase: "ready",
      expected_source_ids: [UUID_A, UUID_A],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /duplicate UUID/.test(i.message))).toBe(true);
    }
  });

  it("rejects unknown fields (strict mode)", () => {
    const result = EvalCase.safeParse({ ...validCase, surprise: true });
    expect(result.success).toBe(false);
  });
});

describe("GoldenSet schema", () => {
  it("accepts a valid doc", () => {
    expect(() => GoldenSet.parse(validDoc)).not.toThrow();
  });

  it("rejects YAML version mismatch with code SCHEMA_VERSION", () => {
    const result = GoldenSet.safeParse({ ...(validDoc as object), version: "9.9.9" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => /YAML version .* != code SCHEMA_VERSION/.test(i.message)),
      ).toBe(true);
    }
  });

  it("rejects duplicate case ids across cases", () => {
    const doc = makeDoc([{ id: "en-001" }, { id: "en-001" }]);
    const result = GoldenSet.safeParse(doc);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /duplicate case id "en-001"/.test(i.message))).toBe(
        true,
      );
    }
  });
});
