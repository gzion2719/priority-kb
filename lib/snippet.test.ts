import { describe, expect, it } from "vitest";

import {
  CANDIDATE_SNIPPET_MAX_CHARS,
  projectCandidateSnippet,
  safeSnippetSlice,
  SNIPPET_ELLIPSIS,
  stripSynthRepPrefix,
} from "@/lib/snippet";

describe("stripSynthRepPrefix", () => {
  it("strips `# <title>\\n` prefix when body starts with it (keyword-only synth-rep path)", () => {
    expect(stripSynthRepPrefix("# My Title\nThe body.", "My Title")).toBe("The body.");
  });

  it("returns body unchanged when prefix is absent (ANN-best-chunk path)", () => {
    expect(stripSynthRepPrefix("a chunk of body text", "My Title")).toBe("a chunk of body text");
  });

  it("does NOT strip when leading `# …\\n` line names a different title (defensive)", () => {
    // Negative-assertion: a regression that pattern-stripped any leading
    // `# ...\n` line would erase real h1 markdown from a chunk's body.
    // Pin exact-title-match semantics.
    expect(stripSynthRepPrefix("# Other Title\nBody", "My Title")).toBe("# Other Title\nBody");
  });

  it("returns empty string when body is exactly the prefix (empty-body keyword entry)", () => {
    // synthesizeKeywordOnlyRepresentative returns just `# ${title}\n` for
    // an empty body (lib/retrieval-rerank-input.ts:130-132). The hover
    // snippet for that pathological case is empty — let the UI render
    // nothing rather than show "# Title\n" verbatim.
    expect(stripSynthRepPrefix("# My Title\n", "My Title")).toBe("");
  });
});

describe("safeSnippetSlice", () => {
  it("returns body unchanged when length <= maxChars (no ellipsis appended)", () => {
    expect(safeSnippetSlice("short", 240)).toBe("short");
    // Negative-assertion: regression that always appended "…" would fire.
    expect(safeSnippetSlice("short", 240).endsWith(SNIPPET_ELLIPSIS)).toBe(false);
  });

  it("appends ellipsis exactly once when truncating an ASCII body", () => {
    const body = "a".repeat(300);
    expect(safeSnippetSlice(body, 240)).toBe("a".repeat(240) + SNIPPET_ELLIPSIS);
  });

  it("backs off the cut to avoid splitting a Hebrew niqqud combining sequence", () => {
    // U+05D0 (Aleph, base) + U+05B7 (Patah, combining mark) — 2 chars each.
    // Naïve slice at 240 would land between base #120 and its niqqud,
    // keeping the base and dropping the diacritic. safeSnippetSlice backs
    // off so the snippet ends on a base+mark pair, not an orphan base.
    const pair = "אַ";
    const body = pair.repeat(200); // 400 chars total
    const out = safeSnippetSlice(body, 240);
    expect(out.endsWith(SNIPPET_ELLIPSIS)).toBe(true);
    const kept = out.slice(0, -1);
    // The last kept char must be a mark (Patah) — proving we backed off
    // to keep the pair intact. A regression that sliced at exactly 240
    // would leave the last kept char as "א" (base, with niqqud dropped).
    expect(/\p{M}/u.test(kept[kept.length - 1]!)).toBe(true);
  });

  it("backs off the cut to avoid orphaning a UTF-16 high surrogate", () => {
    // U+1F600 (😀) encodes as a surrogate pair (2 code units). 121 emoji
    // = 242 code units; a naïve cap at 240 would land in the middle of
    // the 121st emoji, keeping the high surrogate without its low half.
    const body = "😀".repeat(121);
    const out = safeSnippetSlice(body, 240);
    const kept = out.slice(0, -1);
    // No orphan halves — kept length must be even (each emoji is 2 units).
    expect(kept.length % 2).toBe(0);
    expect(out.endsWith(SNIPPET_ELLIPSIS)).toBe(true);
  });

  it("uses the default cap CANDIDATE_SNIPPET_MAX_CHARS when maxChars omitted", () => {
    const body = "x".repeat(CANDIDATE_SNIPPET_MAX_CHARS + 10);
    // Pure ASCII: cut lands exactly at the cap, no back-off; total length
    // is cap + 1 (the ellipsis).
    expect(safeSnippetSlice(body)).toBe("x".repeat(CANDIDATE_SNIPPET_MAX_CHARS) + SNIPPET_ELLIPSIS);
  });

  it("handles an empty body without crashing", () => {
    expect(safeSnippetSlice("", 240)).toBe("");
  });
});

describe("projectCandidateSnippet — strip BEFORE cap", () => {
  it("strips the synth-rep prefix before applying the char cap (more user content)", () => {
    // 250 'y' chars prefixed with "# T\n" (4 chars). Slice-then-strip
    // (wrong order) would cap to 240 keeping the prefix, then strip,
    // yielding ~236 user chars. Strip-then-slice (correct) gives the
    // user the full 240 chars of body content.
    const title = "T";
    const body = `# ${title}\n` + "y".repeat(250);
    const out = projectCandidateSnippet(body, title, 240);
    expect(out.startsWith("# ")).toBe(false);
    expect(out).toBe("y".repeat(240) + SNIPPET_ELLIPSIS);
  });

  it("passes through unchanged when neither prefix nor cap fires", () => {
    expect(projectCandidateSnippet("hello", "My Title", 240)).toBe("hello");
  });

  it("returns empty string when post-strip body is empty (no spurious ellipsis)", () => {
    // synthesizeKeywordOnlyRepresentative on an empty body returns just
    // `# ${title}\n`. After strip the body is "". The composer must not
    // fall through to the cap path and emit a lone ellipsis.
    expect(projectCandidateSnippet("# T\n", "T", 240)).toBe("");
  });
});

describe("safeSnippetSlice — pathological all-marks body (CR M1)", () => {
  it("terminates cleanly on a body that's entirely combining marks", () => {
    // 300 lone Patah marks — every char fails the back-off test, so the
    // loop drives cut to 0 and we return the bare ellipsis. The point
    // of this test is that the loop terminates without an out-of-bounds
    // access (charAt vs []!).
    const body = "ַ".repeat(300);
    expect(safeSnippetSlice(body, 240)).toBe(SNIPPET_ELLIPSIS);
  });
});
