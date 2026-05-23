// lib/retrieval-retry-prefix.test.ts — hash-stability + non-empty content
// floors for the §5 stricter-prefix.

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { RETRIEVAL_RETRY_PREFIX_HASH, STRICTER_PROMPT_PREFIX } from "./retrieval-retry-prefix";

describe("STRICTER_PROMPT_PREFIX", () => {
  it("is a non-empty string", () => {
    expect(typeof STRICTER_PROMPT_PREFIX).toBe("string");
    expect(STRICTER_PROMPT_PREFIX.length).toBeGreaterThan(0);
  });

  it("names every §5 contract invariant the validator enforces", () => {
    // Negative-assertion discipline: each name is the discriminant the
    // validator returns. If the prefix stops naming any of them, the model
    // loses the cue for the most common failure mode in 2c-i audit data.
    expect(STRICTER_PROMPT_PREFIX).toMatch(/inline citation/i);
    expect(STRICTER_PROMPT_PREFIX).toMatch(/Sources:/);
    expect(STRICTER_PROMPT_PREFIX).toMatch(/set/i);
    expect(STRICTER_PROMPT_PREFIX).toMatch(/v4/i);
    expect(STRICTER_PROMPT_PREFIX).toMatch(/no prose follows/i);
  });
});

describe("RETRIEVAL_RETRY_PREFIX_HASH", () => {
  it("is a 64-char lowercase hex SHA-256 digest", () => {
    expect(RETRIEVAL_RETRY_PREFIX_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches a fresh SHA-256 of STRICTER_PROMPT_PREFIX", () => {
    const fresh = createHash("sha256")
      .update(Buffer.from(STRICTER_PROMPT_PREFIX, "utf8"))
      .digest("hex");
    expect(RETRIEVAL_RETRY_PREFIX_HASH).toBe(fresh);
  });

  it("changes when the prefix string changes (sanity floor)", () => {
    const otherHash = createHash("sha256")
      .update(Buffer.from(STRICTER_PROMPT_PREFIX + "x", "utf8"))
      .digest("hex");
    expect(otherHash).not.toBe(RETRIEVAL_RETRY_PREFIX_HASH);
  });

  it("equals the pinned hex value that 2c-i audit rows already wrote", () => {
    // Iron-rule #10 forward-compat floor: any silent change to the prefix
    // string, the utf8 encoding choice, the createHash algorithm, or any
    // other input to the hash would change this value and break
    // reconciliation against existing audit_log rows from slice 2c-i. A
    // change here forces a deliberate decision: either keep the hash
    // (and the prefix wording is locked in) or bump the value (and accept
    // that prior audit rows reference an unreconstructable prefix).
    expect(RETRIEVAL_RETRY_PREFIX_HASH).toBe(
      "3625a7fba5faeec4a4d2c3454c8955563f1df76acee34d80c758e5d855ddf1c3",
    );
  });
});
