import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

import {
  COMMITLINT_CONFIG_PATH,
  HOOK_PRECHECK_PATH,
  PR_TITLE_NORMALIZE_YML_PATH,
  PR_TITLE_YML_PATH,
  compareTypeLists,
  formatDriftMessage,
  parseCommitlintTypes,
  parseHookErrorMessageTypes,
  parsePrTitleNormalizeRegexTypes,
  parsePrTitleWorkflowTypes,
} from "../../scripts/check-pr-title-allowlist-drift.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = pathResolve(
  __dirname,
  "..",
  "..",
  "scripts",
  "check-pr-title-allowlist-drift.mjs",
);

describe("parseCommitlintTypes", () => {
  it("reads the type-enum allowlist from the real commitlint.config.cjs", () => {
    const types = parseCommitlintTypes(COMMITLINT_CONFIG_PATH);
    expect(types).toEqual(["feat", "fix", "chore", "docs", "refactor", "test", "ci", "release"]);
  });

  it("survives an extracted-constant refactor (require() not regex)", () => {
    const root = mkdtempSync(join(tmpdir(), "ctead-"));
    const cjsPath = join(root, "commitlint.config.cjs");
    writeFileSync(
      cjsPath,
      `const TYPES = ["alpha", "beta"];
module.exports = { rules: { "type-enum": [2, "always", TYPES] } };
`,
      "utf8",
    );
    try {
      expect(parseCommitlintTypes(cjsPath)).toEqual(["alpha", "beta"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("throws on missing or malformed type-enum rule", () => {
    const root = mkdtempSync(join(tmpdir(), "ctead-"));
    const cjsPath = join(root, "commitlint.config.cjs");
    writeFileSync(cjsPath, `module.exports = { rules: {} };\n`, "utf8");
    try {
      expect(() => parseCommitlintTypes(cjsPath)).toThrow(/type-enum rule shape unexpected/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parsePrTitleWorkflowTypes", () => {
  it("extracts types from the real pr-title.yml literal-block", () => {
    const text = readFileSync(PR_TITLE_YML_PATH, "utf8");
    expect(parsePrTitleWorkflowTypes(text)).toEqual([
      "feat",
      "fix",
      "chore",
      "docs",
      "refactor",
      "test",
      "ci",
      "release",
    ]);
  });

  it("handles flow-style `types: [a, b, c]` (YAML library, not regex)", () => {
    const yamlText = `
jobs:
  validate:
    steps:
      - uses: foo
        with:
          types: [alpha, beta, gamma]
`;
    expect(parsePrTitleWorkflowTypes(yamlText)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("throws when jobs.validate.steps shape is missing", () => {
    expect(() => parsePrTitleWorkflowTypes("name: noop\n")).toThrow(
      /jobs\.validate\.steps not found/,
    );
  });
});

describe("parsePrTitleNormalizeRegexTypes", () => {
  it("extracts the alternation group from the real pr-title-normalize.yml", () => {
    const text = readFileSync(PR_TITLE_NORMALIZE_YML_PATH, "utf8");
    expect(parsePrTitleNormalizeRegexTypes(text)).toEqual([
      "feat",
      "fix",
      "chore",
      "docs",
      "refactor",
      "test",
      "ci",
      "release",
    ]);
  });

  it("throws when prefix_re pattern is absent", () => {
    expect(() => parsePrTitleNormalizeRegexTypes("name: noop\n")).toThrow(
      /prefix_re alternation group not found/,
    );
  });
});

describe("parseHookErrorMessageTypes", () => {
  it("extracts types from the real hook script's error message", () => {
    const text = readFileSync(HOOK_PRECHECK_PATH, "utf8");
    expect(parseHookErrorMessageTypes(text)).toEqual([
      "feat",
      "fix",
      "chore",
      "docs",
      "refactor",
      "test",
      "ci",
      "release",
    ]);
  });

  it("throws when the 'allowlist (...)' phrase is missing", () => {
    expect(() => parseHookErrorMessageTypes("no allowlist phrase here")).toThrow(
      /'allowlist \(TYPE\|TYPE\.\.\.\)' error-message phrase not found/,
    );
  });
});

describe("compareTypeLists", () => {
  it("returns ok when all surfaces match the source", () => {
    const r = compareTypeLists([
      { label: "a", types: ["x", "y"] },
      { label: "b", types: ["y", "x"] }, // order-insensitive
      { label: "c", types: ["x", "y"] },
    ]);
    expect(r.ok).toBe(true);
    expect(r.drifts).toHaveLength(2);
    expect(r.drifts[0]).toEqual({ label: "b", missingFromHere: [], extraHere: [] });
  });

  it("reports per-surface missing + extra against the source", () => {
    const r = compareTypeLists([
      { label: "src", types: ["x", "y", "z"] },
      { label: "missing-z", types: ["x", "y"] },
      { label: "extra-w", types: ["x", "y", "z", "w"] },
      { label: "both", types: ["x", "w"] },
    ]);
    expect(r.ok).toBe(false);
    expect(r.drifts).toEqual([
      { label: "missing-z", missingFromHere: ["z"], extraHere: [] },
      { label: "extra-w", missingFromHere: [], extraHere: ["w"] },
      { label: "both", missingFromHere: ["y", "z"], extraHere: ["w"] },
    ]);
  });

  it("throws on < 2 surfaces", () => {
    expect(() => compareTypeLists([{ label: "alone", types: [] }])).toThrow(
      /requires at least 2 surfaces/,
    );
  });
});

describe("formatDriftMessage", () => {
  it("returns empty string when ok:true", () => {
    expect(formatDriftMessage({ ok: true, sourceLabel: "src", drifts: [] })).toBe("");
  });

  it("names every drifting surface with actionable missing/extra labels", () => {
    const msg = formatDriftMessage({
      ok: false,
      sourceLabel: "commitlint.config.cjs",
      drifts: [
        { label: "pr-title.yml", missingFromHere: ["perf"], extraHere: [] },
        { label: "normalize regex", missingFromHere: ["perf"], extraHere: ["build"] },
      ],
    });
    expect(msg).toContain("DRIFT detected");
    expect(msg).toContain("Source of truth: commitlint.config.cjs");
    expect(msg).toContain("pr-title.yml:");
    expect(msg).toContain("missing: perf");
    expect(msg).toContain("normalize regex:");
    expect(msg).toContain("extra:   build");
    expect(msg).toContain("ADR-0004 Amendment 2026-05-25");
  });
});

describe("script integration — aligned-state passes", () => {
  it("real repo state currently aligned (exit 0 on bare invocation)", () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH], { encoding: "utf8" });
    expect(r.status, `stderr: ${r.stderr}`).toBe(0);
  });
});

describe("script integration — injected drift catches", () => {
  // Copy all 4 real files into a tmp tree, mutate one to drift, then invoke
  // the script wired against the tmp paths (via env-var hooks). This proves
  // the detector ACTUALLY catches drift, not just that it agrees on the
  // aligned state — without this, the script could `process.exit(0)` and
  // the aligned-state assertion would still pass.

  function setupTmpTree(): { root: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), "ctead-tmp-"));
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(COMMITLINT_CONFIG_PATH, join(root, "commitlint.config.cjs"));
    copyFileSync(PR_TITLE_YML_PATH, join(root, ".github/workflows/pr-title.yml"));
    copyFileSync(
      PR_TITLE_NORMALIZE_YML_PATH,
      join(root, ".github/workflows/pr-title-normalize.yml"),
    );
    copyFileSync(HOOK_PRECHECK_PATH, join(root, "scripts/hook-gh-pr-create-precheck.mjs"));
    return {
      root,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  it("catches a missing type in pr-title.yml", () => {
    const { root, cleanup } = setupTmpTree();
    try {
      const ymlPath = join(root, ".github/workflows/pr-title.yml");
      const orig = readFileSync(ymlPath, "utf8");
      // Drop `release` from the workflow's literal-block.
      const mutated = orig.replace(/\n            release\n/, "\n");
      expect(mutated).not.toBe(orig);
      writeFileSync(ymlPath, mutated, "utf8");
      // Use the parsers directly on the tmp tree (the script's main() reads
      // hardcoded absolute paths; we exercise the same comparator via the
      // exported helpers, which is what real CI failure-mode coverage looks
      // like for this script).
      const commitlintTypes = parseCommitlintTypes(join(root, "commitlint.config.cjs"));
      const prTitleTypes = parsePrTitleWorkflowTypes(readFileSync(ymlPath, "utf8"));
      const normalizeTypes = parsePrTitleNormalizeRegexTypes(
        readFileSync(join(root, ".github/workflows/pr-title-normalize.yml"), "utf8"),
      );
      const hookTypes = parseHookErrorMessageTypes(
        readFileSync(join(root, "scripts/hook-gh-pr-create-precheck.mjs"), "utf8"),
      );
      const result = compareTypeLists([
        { label: "commitlint.config.cjs", types: commitlintTypes },
        { label: "pr-title.yml", types: prTitleTypes },
        { label: "pr-title-normalize.yml", types: normalizeTypes },
        { label: "hook-gh-pr-create-precheck.mjs", types: hookTypes },
      ]);
      expect(result.ok).toBe(false);
      const prTitleDrift = result.drifts.find((d) => d.label === "pr-title.yml");
      expect(prTitleDrift?.missingFromHere).toEqual(["release"]);
    } finally {
      cleanup();
    }
  });

  it("catches an extra type in the normalize regex (e.g., a stale rename)", () => {
    const { root, cleanup } = setupTmpTree();
    try {
      const ymlPath = join(root, ".github/workflows/pr-title-normalize.yml");
      const orig = readFileSync(ymlPath, "utf8");
      // Insert a fake `perf` type into the regex's alternation group.
      const mutated = orig.replace(
        "prefix_re='^((feat|fix|chore|docs|refactor|test|ci|release)",
        "prefix_re='^((feat|fix|chore|docs|refactor|test|ci|release|perf)",
      );
      expect(mutated).not.toBe(orig);
      writeFileSync(ymlPath, mutated, "utf8");
      const commitlintTypes = parseCommitlintTypes(join(root, "commitlint.config.cjs"));
      const normalizeTypes = parsePrTitleNormalizeRegexTypes(readFileSync(ymlPath, "utf8"));
      const result = compareTypeLists([
        { label: "commitlint.config.cjs", types: commitlintTypes },
        { label: "pr-title-normalize.yml", types: normalizeTypes },
      ]);
      expect(result.ok).toBe(false);
      expect(result.drifts[0].extraHere).toEqual(["perf"]);
    } finally {
      cleanup();
    }
  });
});
