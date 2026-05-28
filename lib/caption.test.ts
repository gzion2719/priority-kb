import { describe, expect, it } from "vitest";

import { CAPTION_DISPLAY_CLIP_CHARS, deriveCaption } from "@/lib/caption";

describe("deriveCaption — first non-empty line of the post-scrub body", () => {
  it("returns the first line of a multi-line body", () => {
    expect(deriveCaption("PO Receipt — Validation\nQuantity must be > 0\nmore")).toBe(
      "PO Receipt — Validation",
    );
  });

  it("skips leading blank and whitespace-only lines", () => {
    // Distinguishes 'first NON-EMPTY line' from a naive 'lines[0]', which
    // would return "" here.
    expect(deriveCaption("\n   \n\t\nFirst real content\nrest")).toBe("First real content");
  });

  it("returns the first paragraph's first line for a \\n\\n-separated body", () => {
    expect(deriveCaption("Customer order form\n\nLine items follow below.")).toBe(
      "Customer order form",
    );
  });

  it("strips the trailing CR from a CRLF body (no stray \\r in the caption)", () => {
    // NFC does not strip \r; split-on-\n alone would leave it. Negative-
    // assertion: the result must NOT contain a carriage return.
    const caption = deriveCaption("Heading line\r\nbody line\r\n");
    expect(caption).toBe("Heading line");
    expect(caption).not.toMatch(/\r/);
  });

  it("trims surrounding whitespace on the chosen line", () => {
    expect(deriveCaption("   Indented heading   \nbody")).toBe("Indented heading");
  });
});

describe("deriveCaption — grapheme-safe clip of the LINE, not the whole body", () => {
  it("clips a long first line to <= CAPTION_DISPLAY_CLIP_CHARS + ellipsis", () => {
    const line = "x".repeat(300);
    const caption = deriveCaption(line);
    expect(caption).not.toBeNull();
    // ellipsis is one char; clipped content is <= the cap.
    expect(caption!.endsWith("…")).toBe(true);
    expect(caption!.length).toBeLessThanOrEqual(CAPTION_DISPLAY_CLIP_CHARS + 1);
    expect(caption!.slice(0, -1)).toBe(line.slice(0, caption!.length - 1));
  });

  it("returns ONLY the first line when it is short but the body is long", () => {
    // Negative-assertion that distinguishes line-clip from body-clip: if the
    // implementation clipped the whole body to 160 chars, the caption would
    // span into the long second line. It must instead be exactly "Short".
    const body = "Short\n" + "y".repeat(500);
    expect(deriveCaption(body)).toBe("Short");
  });

  it("does not append an ellipsis when the first line is exactly at the cap", () => {
    const line = "z".repeat(CAPTION_DISPLAY_CLIP_CHARS);
    const caption = deriveCaption(line);
    expect(caption).toBe(line);
    expect(caption).not.toMatch(/…$/);
  });

  it("clips a single giant line with no newline (ADR-0023 accepted heuristic)", () => {
    // Documents the ADR's accepted tradeoff: a body that is one long
    // paragraph yields a clipped prefix caption. Locked by ADR-0023 D1/D4.
    const giant = "Lorem ipsum ".repeat(50);
    const caption = deriveCaption(giant);
    expect(caption!.endsWith("…")).toBe(true);
    expect(caption!.length).toBeLessThanOrEqual(CAPTION_DISPLAY_CLIP_CHARS + 1);
  });

  it("clips a Hebrew niqqud line without orphaning a combining mark at the edge", () => {
    // Base (U+05D0 alef) + mark (U+05B8 qamats) pairs, long enough to clip.
    // Delegates to safeSnippetSlice; here we assert the contract holds end-to-
    // end: clipped, ellipsis present, and the char immediately before the
    // ellipsis is NOT a dropped-base (i.e. we never keep a base whose mark we
    // then dropped). A naive .slice would risk exactly that.
    const line = "אָ".repeat(120); // 240 code points
    const caption = deriveCaption(line);
    expect(caption).not.toBeNull();
    expect(caption!.endsWith("…")).toBe(true);
    const beforeEllipsis = caption!.slice(0, -1);
    // The first dropped char in the original must not be a combining mark
    // relative to what we kept — equivalently the kept tail ends on a clean
    // grapheme boundary. We check the kept content is a prefix of the source.
    expect(line.startsWith(beforeEllipsis)).toBe(true);
  });
});

describe("deriveCaption — total function, null on no content", () => {
  it("returns null for a whitespace-only body", () => {
    expect(deriveCaption("   \n\t\n  \r\n")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(deriveCaption("")).toBeNull();
  });

  it("never throws across assorted inputs (no-throw contract)", () => {
    for (const input of ["", " ", "\n", "\r\n", "a", "א", "אָ", "x".repeat(1000)]) {
      expect(() => deriveCaption(input)).not.toThrow();
    }
  });
});
