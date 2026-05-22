// lib/retrieval-synth-input.test.ts — unit tests + source-file mechanical
// floors for the stage-D synth-input block builder.
//
// Pure helper, no I/O — every test is inline-fixture-driven.

import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SENSITIVITY_VALUES,
  SYNTH_INPUT_SCORE_PRECISION,
  type SynthInputChunk,
  buildSynthContext,
  escapeAttribute,
  escapeXmlText,
} from "@/lib/retrieval-synth-input";

const UUID_A = "a3f1c2d4-5e6b-4c7a-9d8e-0f1a2b3c4d5e";
const UUID_B = "b29e0712-3456-4789-a012-3456789abcde";
const UUID_C = "c1234567-89ab-4cde-9f01-23456789abcd";

function makeChunk(overrides: Partial<SynthInputChunk> = {}): SynthInputChunk {
  return {
    entry_id: UUID_A,
    title: "How to lock a field",
    body: "Press F11 with focus on the field.",
    category: "shortcuts",
    tags: ["form", "shortcut"],
    source_pointer: "ticket-42",
    last_verified_at: "2026-05-21T00:00:00Z",
    sensitivity: "public",
    score: 0.87654321,
    ...overrides,
  };
}

describe("buildSynthContext — empty input", () => {
  it("returns an empty array for empty input", () => {
    expect(buildSynthContext([])).toEqual([]);
  });
});

describe("buildSynthContext — single chunk shape", () => {
  it("renders all 9 fields per ADR-0012 §D, with `<source>` matching v0.2.0 prompt", () => {
    const [block] = buildSynthContext([makeChunk()]);
    expect(block).toBeDefined();
    // All 9 fields named in retrieval-agent.md line 20 must appear as tags
    // or attributes in the rendered block. (`source_pointer` TS field
    // renders as `<source>` XML tag per file header.)
    expect(block).toContain(`entry_id="${UUID_A}"`);
    expect(block).toContain(`index="1"`);
    expect(block).toContain(`score="0.8765"`);
    expect(block).toContain(`<title>How to lock a field</title>`);
    expect(block).toContain(`<category>shortcuts</category>`);
    expect(block).toContain(`<tags>form, shortcut</tags>`);
    expect(block).toContain(`<source>ticket-42</source>`);
    expect(block).toContain(`<last_verified_at>2026-05-21T00:00:00Z</last_verified_at>`);
    expect(block).toContain(`<sensitivity>public</sensitivity>`);
    expect(block).toContain(`<body>Press F11 with focus on the field.</body>`);
    // Negative-assertion: the v0.2.0 prompt says `source`, not `source_pointer`.
    // If the helper ever renders the TS field name into the XML, this catches it.
    expect(block).not.toMatch(/<source_pointer>/);
    expect(block).not.toMatch(/<\/source_pointer>/);
  });
});

describe("buildSynthContext — order preservation (negative-assertion tight)", () => {
  it("preserves input array order across distinct chunks with non-monotonic scores", () => {
    // Scores intentionally NOT in sorted order; any hidden sort by score would
    // permute the output and this assertion catches the swap.
    const chunks: SynthInputChunk[] = [
      makeChunk({ entry_id: UUID_C, title: "C-first", score: 0.1 }),
      makeChunk({ entry_id: UUID_A, title: "A-second", score: 0.9 }),
      makeChunk({ entry_id: UUID_B, title: "B-third", score: 0.5 }),
    ];
    const result = buildSynthContext(chunks);
    expect(result).toHaveLength(3);

    // Per-position assertion — each output block must contain the entry_id
    // AT THAT INDEX in the input. A permutation breaks this.
    expect(result[0]).toContain(`entry_id="${UUID_C}"`);
    expect(result[0]).toContain(`index="1"`);
    expect(result[1]).toContain(`entry_id="${UUID_A}"`);
    expect(result[1]).toContain(`index="2"`);
    expect(result[2]).toContain(`entry_id="${UUID_B}"`);
    expect(result[2]).toContain(`index="3"`);

    // Negative-assertion: confirm the OUT-OF-ORDER assignment didn't sneak in,
    // symmetric across all three output positions (catches any permutation).
    expect(result[0]).not.toContain(`entry_id="${UUID_A}"`);
    expect(result[0]).not.toContain(`entry_id="${UUID_B}"`);
    expect(result[1]).not.toContain(`entry_id="${UUID_B}"`);
    expect(result[1]).not.toContain(`entry_id="${UUID_C}"`);
    expect(result[2]).not.toContain(`entry_id="${UUID_A}"`);
    expect(result[2]).not.toContain(`entry_id="${UUID_C}"`);
  });
});

describe("buildSynthContext — XML escaping", () => {
  it("escapes `<`, `>`, `&` in text-node content (title + body)", () => {
    const [block] = buildSynthContext([
      makeChunk({
        title: "A & B <test>",
        body: "if x < y > z & w then ...",
      }),
    ]);
    // Escaped forms present.
    expect(block).toContain(`<title>A &amp; B &lt;test&gt;</title>`);
    expect(block).toContain(`<body>if x &lt; y &gt; z &amp; w then ...</body>`);
    // Raw forms absent in the text-node content (the tag delimiters
    // themselves contain `<` `>`, so we assert only on the SPECIFIC
    // unescaped sequences that would only come from unescaped content).
    expect(block).not.toMatch(/<title>A & B <test><\/title>/);
    expect(block).not.toContain(`if x < y > z & w then`);
  });

  it("escapes special chars in tags (joined by `, `)", () => {
    const [block] = buildSynthContext([makeChunk({ tags: ["a&b", "c<d", "e>f"] })]);
    expect(block).toContain(`<tags>a&amp;b, c&lt;d, e&gt;f</tags>`);
  });

  it("escapeAttribute additionally escapes single and double quotes", () => {
    expect(escapeAttribute(`he said "hi" & 'bye'`)).toBe(
      `he said &quot;hi&quot; &amp; &apos;bye&apos;`,
    );
  });

  it("escapeXmlText does NOT escape quotes (text-node only)", () => {
    expect(escapeXmlText(`"quoted" & 'apos'`)).toBe(`"quoted" &amp; 'apos'`);
  });
});

describe("buildSynthContext — score formatting determinism", () => {
  it("uses fixed precision of SYNTH_INPUT_SCORE_PRECISION decimals", () => {
    expect(SYNTH_INPUT_SCORE_PRECISION).toBe(4);
    const [block] = buildSynthContext([makeChunk({ score: 0.123456789 })]);
    expect(block).toContain(`score="0.1235"`);
    // Negative-assertion: no IEEE-754 tail leakage.
    expect(block).not.toContain(`0.123456789`);
    expect(block).not.toContain(`0.12345`);
  });

  it("rounds half to nearest per Number.prototype.toFixed", () => {
    const [block] = buildSynthContext([makeChunk({ score: 0.99995 })]);
    // 0.99995.toFixed(4) === "1.0000" — the helper accepts whatever toFixed
    // returns; this test pins the behavior so a future precision bump is
    // an explicit decision, not silent drift.
    expect(block).toContain(`score="1.0000"`);
  });

  it("handles scores outside [0, 1] (Voyage rerank scores aren't bounded)", () => {
    const [block] = buildSynthContext([makeChunk({ score: 1.5 })]);
    expect(block).toContain(`score="1.5000"`);
  });
});

describe("buildSynthContext — null source_pointer", () => {
  it("renders `<source></source>` (empty element, NOT an omitted tag)", () => {
    const [block] = buildSynthContext([makeChunk({ source_pointer: null })]);
    expect(block).toContain(`<source></source>`);
    // Negative-assertion: omitted-tag rendering must NOT be the path taken.
    // If a future refactor drops the tag entirely, this fails.
    const lines = block!.split("\n");
    const sourceLines = lines.filter((l) => l.includes("<source"));
    expect(sourceLines).toHaveLength(1);
    expect(sourceLines[0]).toMatch(/^\s*<source><\/source>\s*$/);
  });

  it("does NOT render the JS string 'null' as the source value", () => {
    const [block] = buildSynthContext([makeChunk({ source_pointer: null })]);
    expect(block).not.toContain(`<source>null</source>`);
  });
});

describe("buildSynthContext — empty tags", () => {
  it("renders `<tags></tags>` for `tags: []` (shape-stable, NOT omitted)", () => {
    const [block] = buildSynthContext([makeChunk({ tags: [] })]);
    expect(block).toContain(`<tags></tags>`);
    // Negative-assertion: the tag must be present even when empty —
    // a maintainer who omits the tag for empty arrays breaks shape stability.
    const lines = block!.split("\n");
    const tagsLines = lines.filter((l) => l.includes("<tags"));
    expect(tagsLines).toHaveLength(1);
    expect(tagsLines[0]).toMatch(/^\s*<tags><\/tags>\s*$/);
  });
});

describe("buildSynthContext — sensitivity validation (iron rule #6 boundary floor)", () => {
  it("accepts all three SENSITIVITY_VALUES members", () => {
    for (const s of SENSITIVITY_VALUES) {
      expect(() => buildSynthContext([makeChunk({ sensitivity: s })])).not.toThrow();
    }
  });

  it("throws RangeError on a sensitivity outside the enum", () => {
    // Cast required — the type system already forbids this at compile time;
    // we test the runtime defensive floor for callers that bypass the type.
    const bad = makeChunk({ sensitivity: "secret" as unknown as "public" });
    expect(() => buildSynthContext([bad])).toThrow(RangeError);
    expect(() => buildSynthContext([bad])).toThrow(/sensitivity/);
  });

  it("error message names the actual offending value (not a generic message)", () => {
    const bad = makeChunk({ sensitivity: "TOP_SECRET" as unknown as "public" });
    try {
      buildSynthContext([bad]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RangeError);
      expect((err as Error).message).toContain("TOP_SECRET");
      expect((err as Error).message).toContain("public");
      expect((err as Error).message).toContain("internal");
      expect((err as Error).message).toContain("restricted");
    }
  });
});

describe("buildSynthContext — block structural integrity", () => {
  it("each block opens with <entry ...> and closes with </entry>", () => {
    const result = buildSynthContext([makeChunk(), makeChunk({ entry_id: UUID_B })]);
    for (const block of result) {
      expect(block).toMatch(/^<entry\s/);
      expect(block).toMatch(/<\/entry>$/);
    }
  });

  it("attribute order is `index`, `entry_id`, `score`", () => {
    const [block] = buildSynthContext([makeChunk()]);
    // Pin the order so snapshot-style assertions in downstream tests stay stable.
    expect(block).toMatch(/^<entry index="\d+" entry_id="[^"]+" score="[^"]+">/);
  });

  it("child tags appear in the documented order", () => {
    // Pins child-tag order so a refactor swapping <title> and <body> is
    // caught. Line-count was the prior pin but breaks on realistic
    // multi-line bodies (Hebrew procedural steps, ticket bodies, etc.);
    // an order regex is the right pin for shape stability.
    const [block] = buildSynthContext([makeChunk()]);
    expect(block).toMatch(
      /<title>[\s\S]*<\/title>[\s\S]*<category>[\s\S]*<\/category>[\s\S]*<tags>[\s\S]*<\/tags>[\s\S]*<source>[\s\S]*<\/source>[\s\S]*<last_verified_at>[\s\S]*<\/last_verified_at>[\s\S]*<sensitivity>[\s\S]*<\/sensitivity>[\s\S]*<body>[\s\S]*<\/body>/,
    );
  });
});

describe("buildSynthContext — multi-line body (production realism)", () => {
  it("renders a body containing newlines without breaking <entry>...</entry> wrapping", () => {
    // Realistic entry bodies (procedural steps, ticket pastes) contain `\n`.
    // The block must still open with <entry ...> and close with </entry>,
    // and the multi-line body must appear inside <body>...</body>.
    const body = "Step 1: open the form.\nStep 2: press F11.\nStep 3: save.";
    const [block] = buildSynthContext([makeChunk({ body })]);
    expect(block).toMatch(/^<entry\s/);
    expect(block).toMatch(/<\/entry>$/);
    expect(block).toContain(
      `<body>Step 1: open the form.\nStep 2: press F11.\nStep 3: save.</body>`,
    );
  });
});

describe("buildSynthContext — Hebrew round-trip (mirror-policy production case)", () => {
  it("preserves Hebrew characters in title, body, tags, and source verbatim", () => {
    // CLAUDE.md mirrors Hebrew at the product surface; the helper must
    // round-trip Hebrew without mojibake or accidental escaping. The XML
    // escape set (`<`, `>`, `&`, `"`, `'`) does not touch Hebrew code points.
    const chunk = makeChunk({
      title: "איך לנעול שדה",
      body: "לחץ F11 כאשר השדה במיקוד.",
      category: "קיצורי דרך",
      tags: ["טופס", "קיצור"],
      source_pointer: "כרטיס-42",
    });
    const [block] = buildSynthContext([chunk]);
    expect(block).toContain(`<title>איך לנעול שדה</title>`);
    expect(block).toContain(`<body>לחץ F11 כאשר השדה במיקוד.</body>`);
    expect(block).toContain(`<category>קיצורי דרך</category>`);
    expect(block).toContain(`<tags>טופס, קיצור</tags>`);
    expect(block).toContain(`<source>כרטיס-42</source>`);
  });
});

describe("buildSynthContext — finite-score guard (iron rule #6-style boundary floor)", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    it(`throws RangeError on score = ${bad}`, () => {
      expect(() => buildSynthContext([makeChunk({ score: bad })])).toThrow(RangeError);
      expect(() => buildSynthContext([makeChunk({ score: bad })])).toThrow(/finite/);
    });
  }

  it("error message names the actual offending value", () => {
    try {
      buildSynthContext([makeChunk({ score: NaN })]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RangeError);
      expect((err as Error).message).toContain("NaN");
    }
  });

  it('does NOT render `score="NaN"` (negative-assertion: confirms the guard fires before .toFixed)', () => {
    // The bug this guards against: `(NaN).toFixed(4)` returns "NaN", which
    // would render as score="NaN" into the model context. The guard must
    // throw BEFORE we get there.
    let rendered = "";
    try {
      [rendered] = buildSynthContext([makeChunk({ score: NaN })]);
    } catch {
      // expected
    }
    expect(rendered).toBe("");
    expect(rendered).not.toContain("NaN");
  });
});

describe("buildSynthContext — empty entry_id guard (iron rule #3 floor)", () => {
  it("throws RangeError on empty entry_id", () => {
    expect(() => buildSynthContext([makeChunk({ entry_id: "" })])).toThrow(RangeError);
    expect(() => buildSynthContext([makeChunk({ entry_id: "" })])).toThrow(/entry_id/);
  });

  it('does NOT render `entry_id=""` (negative-assertion: confirms guard fires before rendering)', () => {
    let rendered = "";
    try {
      [rendered] = buildSynthContext([makeChunk({ entry_id: "" })]);
    } catch {
      // expected
    }
    expect(rendered).toBe("");
    expect(rendered).not.toContain(`entry_id=""`);
  });
});

describe("buildSynthContext — entry_id attribute-escape end-to-end", () => {
  it("escapes XML-special chars in entry_id when rendered into the attribute slot", () => {
    // entry_id is caller-supplied; the helper does not assert UUID shape, so
    // a caller passing crafted content must NOT break out of the attribute.
    // (UUIDs in production never contain these; this pins defensive behavior.)
    const crafted = `"><script>&'`;
    const [block] = buildSynthContext([makeChunk({ entry_id: crafted })]);
    // Each XML-special char must appear in its escaped form inside the
    // entry_id attribute value.
    expect(block).toMatch(/entry_id="&quot;&gt;&lt;script&gt;&amp;&apos;"/);
    // Negative-assertion: the raw `"` must NOT close the attribute prematurely.
    expect(block).not.toContain(`entry_id="">`);
    expect(block).not.toContain(`<script>`);
  });
});

describe("buildSynthContext — already-escaped input re-escapes correctly", () => {
  it("treats `&lt;` in input as literal text (re-escapes the `&`)", () => {
    // If a caller passes pre-escaped content (e.g. a body that came from an
    // HTML-rendering pipeline), the helper must NOT skip "already-escaped"
    // strings — that would be a security footgun. Re-escape the literal `&`.
    const [block] = buildSynthContext([makeChunk({ body: "&lt;already-escaped&gt;" })]);
    expect(block).toContain(`<body>&amp;lt;already-escaped&amp;gt;</body>`);
    // Negative-assertion: raw `&lt;` must NOT pass through unchanged.
    expect(block).not.toContain(`<body>&lt;already-escaped&gt;</body>`);
  });
});

// ─── Source-file mechanical floors ─────────────────────────────────────────

describe("retrieval-synth-input.ts — source-file mechanical floors", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "retrieval-synth-input.ts"), "utf8");

  it("source file reads no environment (purity floor: helper takes data, not config)", () => {
    // Anchored to the JS namespace expression — would NOT match a paraphrase
    // like "env" in prose. Self-trigger prevention per WORKFLOW.md
    // "Source-file-scan literal self-trigger sub-rule" 2026-05-21.
    expect(src).not.toMatch(/process\.env/);
  });

  it("source file imports no DB driver (no `pg`, anchored to import statement)", () => {
    // Anchored: `/from\s+["']pg["']/` — would NOT match `pgvector` in prose or
    // the package name `pg-pool`. Sibling pattern at retrieval-voyage-rerank.test.ts.
    expect(src).not.toMatch(/from\s+["']pg["']/);
  });

  it("source file imports no SDK (iron rule #8: voyageai/openai/cohere/google/anthropic)", () => {
    expect(src).not.toMatch(/from\s+["']voyage(ai)?["']/);
    expect(src).not.toMatch(/from\s+["']@anthropic[/-]/);
    expect(src).not.toMatch(/from\s+["']openai["']/);
    expect(src).not.toMatch(/from\s+["']cohere-ai["']/);
    expect(src).not.toMatch(/from\s+["']@google\/generative-ai["']/);
  });

  it("source file imports no project DB layer (drizzle / lib/db / lib/queries)", () => {
    // Purity floor for the helper boundary: the route layer hydrates
    // SynthInputChunk[] from DB; this helper renders only.
    expect(src).not.toMatch(/from\s+["']drizzle[-/]/);
    expect(src).not.toMatch(/from\s+["']@\/lib\/db/);
    expect(src).not.toMatch(/from\s+["']@\/drizzle\//);
  });

  it("positive control: env regex catches a synthetic env-namespace read", () => {
    const synthetic = `const k = process.env.FOO;`;
    expect(synthetic).toMatch(/process\.env/);
  });

  it("positive control: pg-import regex catches a synthetic `pg` import", () => {
    const synthetic = `import { Pool } from "pg";`;
    expect(synthetic).toMatch(/from\s+["']pg["']/);
  });

  it("positive control: pg-import regex does NOT match `pgvector` substring", () => {
    // Anchored regex defends against the WORKFLOW.md self-trigger hazard:
    // a future comment mentioning "pgvector HNSW" must NOT trip the import scan.
    const synthetic = `// uses pgvector HNSW indexing`;
    expect(synthetic).not.toMatch(/from\s+["']pg["']/);
  });

  it("positive control: SDK regex catches a synthetic voyageai import", () => {
    const synthetic = `import { Client } from "voyageai";`;
    expect(synthetic).toMatch(/from\s+["']voyage(ai)?["']/);
  });
});
