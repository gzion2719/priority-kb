import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  extractLinkPaths,
  findStaleCandidates,
  parseTickboxes,
} from "../../scripts/verify-roadmap-tickboxes.mjs";

type Candidate = {
  lineNumber: number;
  firstLine: string;
  resolvedClaims: Array<{ rawPath: string; resolved: string }>;
};

function makeFixtureRepo(files: Record<string, string>, roadmap: string) {
  const root = mkdtempSync(join(tmpdir(), "rmtb-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const dest = join(root, rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, body, "utf8");
  }
  const roadmapPath = join(root, "docs", "ROADMAP.md");
  writeFileSync(roadmapPath, roadmap, "utf8");
  return { root, roadmapPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("parseTickboxes", () => {
  it("parses checked and unchecked tickboxes with their first lines", () => {
    const tbs = parseTickboxes(
      ["- [x] done thing", "- [ ] open thing", "- [X] also done"].join("\n"),
    );
    expect(tbs).toHaveLength(3);
    expect(tbs[0].checked).toBe(true);
    expect(tbs[1].checked).toBe(false);
    expect(tbs[2].checked).toBe(true); // case-insensitive
  });

  it("consumes continuation lines until next tickbox / heading / blank line", () => {
    const tbs = parseTickboxes(
      [
        "- [ ] first tickbox",
        "  continuation line one",
        "  continuation line two",
        "",
        "- [ ] second tickbox",
      ].join("\n"),
    );
    expect(tbs).toHaveLength(2);
    expect(tbs[0].body).toContain("continuation line one");
    expect(tbs[0].body).toContain("continuation line two");
    expect(tbs[1].body).not.toContain("continuation");
  });

  it("stops continuation at headings", () => {
    const tbs = parseTickboxes(
      ["- [ ] tickbox", "  continuation", "## Heading", "- [ ] next"].join("\n"),
    );
    expect(tbs).toHaveLength(2);
    expect(tbs[0].body).toContain("continuation");
    expect(tbs[1].firstLine).toBe("next");
  });

  it("reports physical line numbers (1-indexed)", () => {
    const tbs = parseTickboxes(["", "", "- [ ] third-line tickbox"].join("\n"));
    expect(tbs[0].lineNumber).toBe(3);
  });
});

describe("extractLinkPaths", () => {
  it("extracts markdown link targets", () => {
    expect(extractLinkPaths("see [foo](../foo.ts) and [bar](adr/bar.md)")).toEqual([
      "../foo.ts",
      "adr/bar.md",
    ]);
  });

  it("skips http/https/mailto links", () => {
    expect(extractLinkPaths("[ext](https://example.com) and [rel](../x.ts)")).toEqual(["../x.ts"]);
  });

  it("strips anchor fragments", () => {
    expect(extractLinkPaths("[a](../x.md#section)")).toEqual(["../x.md"]);
  });

  it("captures dynamic-route bracket paths", () => {
    expect(extractLinkPaths("[entries](../app/entries/[id]/page.tsx)")).toEqual([
      "../app/entries/[id]/page.tsx",
    ]);
  });
});

describe("findStaleCandidates — synthetic fixtures", () => {
  it("flags an unchecked tickbox whose claim-shaped link resolves (positive control)", () => {
    const f = makeFixtureRepo(
      { "lib/foo.ts": "export const x = 1;\n" },
      "- [ ] feature at [foo](../lib/foo.ts)\n",
    );
    try {
      const out = findStaleCandidates({ roadmapPath: f.roadmapPath, repoRoot: f.root });
      expect(out).toHaveLength(1);
      expect(out[0].resolvedClaims[0].rawPath).toBe("../lib/foo.ts");
    } finally {
      f.cleanup();
    }
  });

  it("does NOT flag plain-prose unchecked tickboxes with no links", () => {
    const f = makeFixtureRepo({}, "- [ ] do the thing manually\n");
    try {
      expect(findStaleCandidates({ roadmapPath: f.roadmapPath, repoRoot: f.root })).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("does NOT flag when the linked file does not exist", () => {
    const f = makeFixtureRepo({}, "- [ ] future at [foo](../lib/foo.ts)\n");
    try {
      expect(findStaleCandidates({ roadmapPath: f.roadmapPath, repoRoot: f.root })).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("does NOT flag checked tickboxes even if the link resolves", () => {
    const f = makeFixtureRepo({ "lib/foo.ts": "x\n" }, "- [x] shipped at [foo](../lib/foo.ts)\n");
    try {
      expect(findStaleCandidates({ roadmapPath: f.roadmapPath, repoRoot: f.root })).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("does NOT flag tickboxes whose only resolving links are reference-shaped (.md)", () => {
    const f = makeFixtureRepo(
      { "docs/adr/0011-foo.md": "# ADR\n" },
      "- [ ] precondition: [ADR-0011](adr/0011-foo.md) revert\n",
    );
    try {
      expect(findStaleCandidates({ roadmapPath: f.roadmapPath, repoRoot: f.root })).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("resolves sibling-relative links (adr/...) against docs/", () => {
    const f = makeFixtureRepo(
      { "docs/adr/foo.md": "# x\n", "lib/foo.ts": "x\n" },
      "- [ ] thing per [ADR](adr/foo.md) at [foo](../lib/foo.ts)\n",
    );
    try {
      const out = findStaleCandidates({ roadmapPath: f.roadmapPath, repoRoot: f.root });
      expect(out).toHaveLength(1);
      // Only the .ts link is reported as a claim; the .md is reference-shaped.
      expect(out[0].resolvedClaims.map((c) => c.rawPath)).toEqual(["../lib/foo.ts"]);
    } finally {
      f.cleanup();
    }
  });

  it("flags dynamic-route bracket paths", () => {
    const f = makeFixtureRepo(
      { "app/entries/[id]/page.tsx": "x\n" },
      "- [ ] detail at [entries](../app/entries/[id]/page.tsx)\n",
    );
    try {
      const out = findStaleCandidates({ roadmapPath: f.roadmapPath, repoRoot: f.root });
      expect(out).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });

  it("retroactive case: 2026-05-24 evals-runner already-shipped", () => {
    // Mimics the historical stale-pointer state: item 7 unchecked, evals/run.ts
    // already on disk. Heuristic must flag.
    const f = makeFixtureRepo(
      { "evals/run.ts": "x\n", "evals/lib.ts": "x\n", "evals/schema.ts": "x\n" },
      "- [ ] Eval runner (`npm run eval`) reports recall@5 — runner shipped at [evals/run.ts](../evals/run.ts) (+ [evals/lib.ts](../evals/lib.ts) + [evals/schema.ts](../evals/schema.ts)).\n",
    );
    try {
      const out = findStaleCandidates({ roadmapPath: f.roadmapPath, repoRoot: f.root });
      expect(out).toHaveLength(1);
      expect(out[0].resolvedClaims.map((c) => c.rawPath)).toEqual([
        "../evals/run.ts",
        "../evals/lib.ts",
        "../evals/schema.ts",
      ]);
    } finally {
      f.cleanup();
    }
  });
});

describe("findStaleCandidates — real ROADMAP.md guard", () => {
  // Allowlist of CURRENTLY-accepted stale-candidate tickboxes. Keyed on a
  // unique substring of the tickbox's first line (NOT line number — line
  // numbers drift on any edit above). Each entry MUST carry a one-line
  // reason; new entries arriving here without a Step-6 conversation is
  // exactly the noise this gate exists to prevent.
  const KNOWN_PENDING_TICKBOXES: Array<{ firstLineSubstring: string; reason: string }> = [
    // Empty as of 2026-05-30: M3 items 6 and 7 both ticked when M3 Acceptance
    // measurement cleared the 0.8/0.9 bar (recall 1.000 / citation_precision
    // 0.943 on real Voyage + Anthropic synth, n=28). The two prior entries
    // (M3 #6 golden-set Phase B, M3 #7 eval runner metrics) are removed
    // because the boxes they allow-listed are now [x]. New unchecked-but-
    // implementation-shipped tickboxes added here MUST carry a one-line
    // reason per the gate convention.
  ];

  it("real ROADMAP candidate set ⊆ KNOWN_PENDING_TICKBOXES", () => {
    const repoRoot = join(__dirname, "..", "..");
    const roadmapPath = join(repoRoot, "docs", "ROADMAP.md");
    const candidates = findStaleCandidates({ roadmapPath, repoRoot }) as Candidate[];

    const unallowlisted = candidates.filter(
      (c) => !KNOWN_PENDING_TICKBOXES.some((k) => c.firstLine.includes(k.firstLineSubstring)),
    );

    if (unallowlisted.length > 0) {
      const detail = unallowlisted
        .map(
          (c) =>
            `  L${c.lineNumber}: ${c.firstLine.slice(0, 120)}\n    claims: ${c.resolvedClaims.map((r) => r.rawPath).join(", ")}`,
        )
        .join("\n");
      throw new Error(
        `New unchecked-but-shipped ROADMAP tickbox(es) detected.\nEither flip the [ ] to [x] or add an entry to KNOWN_PENDING_TICKBOXES with a one-line reason.\n\n${detail}`,
      );
    }

    expect(unallowlisted).toEqual([]);
  });

  it("every KNOWN_PENDING_TICKBOXES entry still matches a real candidate (no rot)", () => {
    const repoRoot = join(__dirname, "..", "..");
    const roadmapPath = join(repoRoot, "docs", "ROADMAP.md");
    const candidates = findStaleCandidates({ roadmapPath, repoRoot }) as Candidate[];

    const stale = KNOWN_PENDING_TICKBOXES.filter(
      (k) => !candidates.some((c) => c.firstLine.includes(k.firstLineSubstring)),
    );

    expect(stale).toEqual([]);
  });
});
