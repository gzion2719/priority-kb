import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import {
  countTestDeclarations,
  countAllTestFiles,
  findSubThresholdFiles,
  walkTestFiles,
  KNOWN_SMALL_FILES,
  REPO_ROOT,
  THRESHOLD,
} from "../../scripts/precheck-test-count-vs-precedent.mjs";

describe("countTestDeclarations — TypeScript", () => {
  it("counts bare it(), test(), and describe(...) groups separately", () => {
    const src = `
      describe("group", () => {
        it("case a", () => {});
        test("case b", () => {});
      });
    `;
    // describe(...) is a group (not counted); it() + test() = 2.
    expect(countTestDeclarations(src, ".ts")).toBe(2);
  });

  it("counts it.skip / it.only / test.skip as declarations", () => {
    const src = `
      it.skip("x", () => {});
      it.only("y", () => {});
      test.skip("z", () => {});
    `;
    expect(countTestDeclarations(src, ".ts")).toBe(3);
  });

  it("counts it.each / test.each / describe.each as one declaration each (no row expansion)", () => {
    const src = `
      it.each([1, 2, 3])("p1 %i", () => {});
      test.each([4, 5])("p2 %i", () => {});
      describe.each(["g1", "g2"])("group %s", () => {
        it("inner", () => {});
      });
    `;
    // it.each + test.each + describe.each + inner it = 4 declarations.
    // (Each .each row is NOT expanded — see script docstring.)
    expect(countTestDeclarations(src, ".ts")).toBe(4);
  });

  it("does not count bare describe(...) groups", () => {
    const src = `
      describe("group A", () => {});
      describe("group B", () => {});
    `;
    expect(countTestDeclarations(src, ".ts")).toBe(0);
  });

  it("returns 0 for empty or no-match source", () => {
    expect(countTestDeclarations("", ".ts")).toBe(0);
    expect(countTestDeclarations("const x = 1;", ".ts")).toBe(0);
  });

  it("handles .tsx files identically", () => {
    const src = `it("a", () => {}); it("b", () => {});`;
    expect(countTestDeclarations(src, ".tsx")).toBe(2);
  });

  it("strips line + block comments before counting (no // it(...) inflation)", () => {
    const src = `
      // it("commented out", () => {});
      /* it("also commented", () => {}); */
      it("real", () => {});
    `;
    expect(countTestDeclarations(src, ".ts")).toBe(1);
  });
});

describe("countTestDeclarations — Python", () => {
  it("counts def test_* at line start", () => {
    const src = `
def test_alpha():
    assert True

def test_beta():
    assert True
`;
    expect(countTestDeclarations(src, ".py")).toBe(2);
  });

  it("counts method def test_* inside a class body (TestCase methods)", () => {
    const src = `
class TestThings:
    def test_one(self):
        pass

    def test_two(self):
        pass
`;
    expect(countTestDeclarations(src, ".py")).toBe(2);
  });

  it("does not count def _test_helper or non-test functions", () => {
    const src = `
def _test_helper():
    pass

def helper_test():
    pass

def test_real():
    pass
`;
    // Only `def test_real` matches; `_test_helper` has a leading underscore
    // BEFORE test_ (regex requires `def test_` at start, not `def _test_`),
    // and `helper_test` doesn't start with test_.
    expect(countTestDeclarations(src, ".py")).toBe(1);
  });

  it("returns 0 for empty source", () => {
    expect(countTestDeclarations("", ".py")).toBe(0);
  });

  it("strips # line comments before counting", () => {
    const src = `
# def test_commented(): pass
def test_real():
    pass
`;
    expect(countTestDeclarations(src, ".py")).toBe(1);
  });
});

describe("walkTestFiles", () => {
  it("returns tracked test files only, excluding e2e", () => {
    const files = walkTestFiles(REPO_ROOT);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((p) => !/\.e2e\.test\.tsx?$/.test(p))).toBe(true);
  });

  it("includes both TS and Python test surfaces", () => {
    const files = walkTestFiles(REPO_ROOT);
    expect(files.some((p) => p.endsWith(".test.ts"))).toBe(true);
    expect(files.some((p) => p.startsWith("api/tests/") && p.endsWith(".py"))).toBe(true);
  });

  it("excludes node_modules and .claude/worktrees naturally via git ls-files", () => {
    const files = walkTestFiles(REPO_ROOT);
    expect(files.some((p) => p.includes("node_modules"))).toBe(false);
    expect(files.some((p) => p.includes(".claude/"))).toBe(false);
  });
});

describe("findSubThresholdFiles + KNOWN_SMALL_FILES gate — real repo", () => {
  it("every sub-threshold file is in KNOWN_SMALL_FILES (gate fires on novel undertested files)", () => {
    const subThreshold = findSubThresholdFiles(REPO_ROOT);
    const allowlistPaths = new Set(KNOWN_SMALL_FILES.map((k) => k.path));
    const unallowlisted = subThreshold.filter((r) => !allowlistPaths.has(r.path));

    if (unallowlisted.length > 0) {
      const detail = unallowlisted
        .map((r) => `  ${r.path} — ${r.count} declarations (< ${THRESHOLD})`)
        .join("\n");
      throw new Error(
        `New sub-threshold test file(s) detected.\n` +
          `Either add tests (preferred — anchor count to a sibling-precedent test file) ` +
          `OR add the file to KNOWN_SMALL_FILES in scripts/precheck-test-count-vs-precedent.mjs ` +
          `with a one-line reason explaining why the file is legitimately small at this count.\n\n` +
          detail,
      );
    }
  });

  it("KNOWN_SMALL_FILES entries have non-empty reasons", () => {
    for (const entry of KNOWN_SMALL_FILES) {
      expect(entry.reason, `entry ${entry.path} missing reason`).toBeTruthy();
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });

  it("KNOWN_SMALL_FILES entries all reference paths that exist in the repo", () => {
    const tracked = new Set(walkTestFiles(REPO_ROOT));
    for (const entry of KNOWN_SMALL_FILES) {
      expect(tracked.has(entry.path), `entry ${entry.path} not in git ls-files`).toBe(true);
    }
  });
});

describe("regression fixture — would have caught the 3rd recurrence (M2b #2 originally-planned 2 tests)", () => {
  it("a synthetic test file with 2 declarations would be flagged sub-threshold", () => {
    // Synthesize the originally-planned api/log.py shape: 2 tests.
    const originalApiLog = `
def test_init_logging_runs():
    pass

def test_emit_one_record():
    pass
`;
    const count = countTestDeclarations(originalApiLog, ".py");
    expect(count).toBe(2);
    expect(count).toBeLessThan(THRESHOLD);
  });

  it("the actual shipped api/log.py is well above threshold (11 declarations as of 2026-05-26)", () => {
    const all = countAllTestFiles(REPO_ROOT);
    const apiLogTest = all.find((r) => r.path === "api/tests/test_log.py");
    expect(apiLogTest, "api/tests/test_log.py should be in the walk").toBeDefined();
    expect(apiLogTest!.count).toBeGreaterThanOrEqual(THRESHOLD);
  });
});

describe("countAllTestFiles", () => {
  it("returns a non-empty sorted list", () => {
    const results = countAllTestFiles(REPO_ROOT);
    expect(results.length).toBeGreaterThan(0);
    // Sorted ascending by count.
    for (let i = 1; i < results.length; i++) {
      expect(results[i].count).toBeGreaterThanOrEqual(results[i - 1].count);
    }
  });

  it("counts an isolated tmp test file correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcvp-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "x@x"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "x"], { cwd: dir });
      mkdirSync(join(dir, "lib"));
      writeFileSync(
        join(dir, "lib", "demo.test.ts"),
        `
        import { describe, it, expect } from "vitest";
        describe("demo", () => {
          it("a", () => {});
          it("b", () => {});
          it("c", () => {});
        });
        `,
      );
      execFileSync("git", ["add", "."], { cwd: dir });
      const results = countAllTestFiles(dir);
      expect(results).toHaveLength(1);
      expect(results[0].path).toBe("lib/demo.test.ts");
      expect(results[0].count).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
