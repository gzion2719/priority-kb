// lib/text-diff.ts — line-level diff for the M4 #3 version history viewer.
//
// LCS-backed diff producing unified-style `add`/`remove`/`context` chunks.
// Pure helper, no deps. Project convention is to avoid adding a node_modules
// entry when a 100-LOC helper suffices.
//
// Constraints:
//   - Body length cap is 200,000 chars per IngestBody. At typical Priority
//     KB entry shape (~50 lines), LCS is cheap. Worst case (200K chars / 1
//     char per line = 200K lines) would blow up the O(m·n) dp matrix.
//   - We cap at MAX_DIFF_LINES per side; if exceeded, return a sentinel
//     `oversized` chunk so the page can render a "diff too large to
//     display" affordance. Both bodies are still rendered side-by-side
//     in that path.
//   - Line splitting tolerates CRLF defensively even though `entries.body`
//     is NFC-normalized at write-time (line endings are not part of NFC,
//     so a historical CRLF body could exist).

export type DiffKind = "context" | "add" | "remove";

export interface DiffChunk {
  kind: DiffKind;
  /** One full line of text — NOT including the line terminator. */
  text: string;
}

export interface DiffResult {
  /** Either the chunk stream OR an `oversized` sentinel; never both. */
  chunks: DiffChunk[];
  /**
   * True iff the input exceeded MAX_DIFF_LINES on either side and the
   * diff was skipped. Callers render an alternative view in this case.
   */
  oversized: boolean;
}

/**
 * Hard cap on lines per side. At 5000 lines, the dp matrix is 25M cells
 * — comfortable in memory but render of that many chunks would produce
 * a multi-MB DOM. Practical KB entries are ≤200 lines; the cap protects
 * against pathological inputs without bottlenecking real ones.
 */
export const MAX_DIFF_LINES = 5000;

/**
 * Compute the line-level diff between two text bodies. CRLF and LF are
 * both treated as line terminators; empty input produces a single empty
 * line on its side (consistent with `String.prototype.split`).
 */
export function diffLines(oldText: string, newText: string): DiffResult {
  // Fast-path: identical → all context. No allocation of dp matrix.
  if (oldText === newText) {
    const lines = splitLines(oldText);
    return { chunks: lines.map((t) => ({ kind: "context", text: t })), oversized: false };
  }

  const a = splitLines(oldText);
  const b = splitLines(newText);

  // Empty-side fast paths — also avoid dp matrix allocation.
  if (a.length === 0 || (a.length === 1 && a[0] === "")) {
    return { chunks: b.map((t) => ({ kind: "add", text: t })), oversized: false };
  }
  if (b.length === 0 || (b.length === 1 && b[0] === "")) {
    return { chunks: a.map((t) => ({ kind: "remove", text: t })), oversized: false };
  }

  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) {
    return { chunks: [], oversized: true };
  }

  const dp = lcsMatrix(a, b);
  return { chunks: backtrack(a, b, dp), oversized: false };
}

/**
 * Defensive line-split: matches LF and CRLF. The trailing empty element
 * that String.split produces on a text ending in a newline is preserved
 * — it represents the empty final line and survives round-trip via
 * `chunks.map(c => c.text).join("\n")`.
 */
function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

function lcsMatrix(a: string[], b: string[]): Uint32Array {
  const m = a.length;
  const n = b.length;
  // Flat Uint32Array is ~4× smaller than nested number[][] arrays and
  // O(m·n) cells already, so the constant factor matters at the cap.
  const dp = new Uint32Array((m + 1) * (n + 1));
  const stride = n + 1;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i * stride + j] = dp[(i - 1) * stride + (j - 1)] + 1;
      } else {
        const up = dp[(i - 1) * stride + j];
        const left = dp[i * stride + (j - 1)];
        dp[i * stride + j] = up >= left ? up : left;
      }
    }
  }
  return dp;
}

function backtrack(a: string[], b: string[], dp: Uint32Array): DiffChunk[] {
  const result: DiffChunk[] = [];
  const stride = b.length + 1;
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ kind: "context", text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i * stride + (j - 1)] >= dp[(i - 1) * stride + j])) {
      result.push({ kind: "add", text: b[j - 1] });
      j--;
    } else {
      result.push({ kind: "remove", text: a[i - 1] });
      i--;
    }
  }
  result.reverse();
  return result;
}
