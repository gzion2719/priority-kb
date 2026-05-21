// lib/retrieval-ann.test.ts — unit tests for annCandidates input validation
// + short-circuit paths. No live DB; integration coverage in
// tests/retrieval-ann.integration.test.ts.

import { describe, expect, it, vi } from "vitest";

import { annCandidates } from "@/lib/retrieval-ann";
import { STUB_DIMENSIONS } from "@/lib/embedding";

function makeVec(value = 0.1): number[] {
  return new Array<number>(STUB_DIMENSIONS).fill(value);
}

// Pool stub: `connect` returns a client with `query` that throws if reached.
// Validation MUST reject before any SQL is issued.
function poolThatMustNotBeUsed() {
  const client = {
    query: vi.fn(() => {
      throw new Error("SQL must not be issued when input validation fails");
    }),
    release: vi.fn(),
  };
  const connect = vi.fn(async () => client);
  return {
    pool: { connect } as unknown as import("pg").Pool,
    client,
    connect,
  };
}

describe("annCandidates — input validation (no SQL issued on failure)", () => {
  const validModel = "stub-sha256";
  const validVersion = "v1";

  it("throws RangeError when queryVector is not an array", async () => {
    const { pool, connect } = poolThatMustNotBeUsed();
    await expect(
      annCandidates(
        pool,
        "not-an-array" as unknown as number[],
        ["public"],
        validModel,
        validVersion,
      ),
    ).rejects.toThrow(RangeError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("throws RangeError when queryVector has wrong dimension", async () => {
    const { pool, connect } = poolThatMustNotBeUsed();
    await expect(
      annCandidates(pool, new Array(512).fill(0.1), ["public"], validModel, validVersion),
    ).rejects.toThrow(RangeError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("throws RangeError when queryVector contains a non-finite element", async () => {
    const { pool, connect } = poolThatMustNotBeUsed();
    const bad = makeVec();
    bad[42] = NaN;
    await expect(annCandidates(pool, bad, ["public"], validModel, validVersion)).rejects.toThrow(
      /queryVector\[42\]/,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("throws RangeError when queryVector is all-zeros (cosine NaN)", async () => {
    const { pool, connect } = poolThatMustNotBeUsed();
    await expect(
      annCandidates(pool, new Array(STUB_DIMENSIONS).fill(0), ["public"], validModel, validVersion),
    ).rejects.toThrow(/all-zeros/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("throws RangeError on limit out of [1, 1000]", async () => {
    const { pool, connect } = poolThatMustNotBeUsed();
    await expect(
      annCandidates(pool, makeVec(), ["public"], validModel, validVersion, 0),
    ).rejects.toThrow(RangeError);
    await expect(
      annCandidates(pool, makeVec(), ["public"], validModel, validVersion, 1001),
    ).rejects.toThrow(RangeError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("throws RangeError on innerLimit out of [1, 1000]", async () => {
    const { pool, connect } = poolThatMustNotBeUsed();
    await expect(
      annCandidates(pool, makeVec(), ["public"], validModel, validVersion, 20, 0),
    ).rejects.toThrow(RangeError);
    await expect(
      annCandidates(pool, makeVec(), ["public"], validModel, validVersion, 20, 1001),
    ).rejects.toThrow(RangeError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("throws RangeError when innerLimit < limit (over-fetch must not be smaller)", async () => {
    const { pool, connect } = poolThatMustNotBeUsed();
    await expect(
      annCandidates(pool, makeVec(), ["public"], validModel, validVersion, 20, 10),
    ).rejects.toThrow(/innerLimit \(10\).*limit \(20\)/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("allows innerLimit === limit boundary (no over-fetch but legal)", async () => {
    // Boundary case: caller deliberately disables over-fetch. Validator must
    // accept it; this test pins that limit === innerLimit does NOT throw.
    // The call WILL acquire a connection and reach the (stub) query — so
    // we only assert "did not throw at validation time" by letting the
    // stub-query rejection bubble as a different error.
    const { pool } = poolThatMustNotBeUsed();
    await expect(
      annCandidates(pool, makeVec(), ["public"], validModel, validVersion, 20, 20),
    ).rejects.toThrow(/SQL must not be issued|BEGIN/);
  });

  it("throws RangeError on empty / whitespace embeddingModel", async () => {
    const { pool, connect } = poolThatMustNotBeUsed();
    await expect(annCandidates(pool, makeVec(), ["public"], "", validVersion)).rejects.toThrow(
      RangeError,
    );
    await expect(annCandidates(pool, makeVec(), ["public"], "   ", validVersion)).rejects.toThrow(
      RangeError,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("throws RangeError on empty / whitespace embeddingVersion", async () => {
    const { pool, connect } = poolThatMustNotBeUsed();
    await expect(annCandidates(pool, makeVec(), ["public"], validModel, "")).rejects.toThrow(
      RangeError,
    );
    await expect(annCandidates(pool, makeVec(), ["public"], validModel, "\t\n")).rejects.toThrow(
      RangeError,
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("empty sensitivity allow-list returns [] without acquiring a connection", async () => {
    const { pool, connect } = poolThatMustNotBeUsed();
    const result = await annCandidates(pool, makeVec(), [], validModel, validVersion);
    expect(result).toEqual([]);
    expect(connect).not.toHaveBeenCalled();
  });
});
