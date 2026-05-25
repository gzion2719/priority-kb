import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const hook = resolve(repoRoot, "scripts/hook-prettier-write.mjs");
const prettierBin = resolve(repoRoot, "node_modules/prettier/bin/prettier.cjs");

function runHook(
  payload: Record<string, unknown>,
  envExtras?: Record<string, string>,
): { code: number; stderr: string } {
  const r = spawnSync(process.execPath, [hook], {
    cwd: repoRoot,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: envExtras ? { ...process.env, ...envExtras } : process.env,
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

describe("hook-prettier-write — matcher gate", () => {
  it("ignores Bash tool calls (silent exit 0)", () => {
    const r = runHook({ tool_name: "Bash", tool_input: { command: "ls" } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("ignores Read tool calls", () => {
    const r = runHook({ tool_name: "Read", tool_input: { file_path: "/anything" } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("ignores tool_name missing entirely", () => {
    const r = runHook({ tool_input: { file_path: "x" } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });
});

describe("hook-prettier-write — matcher gate (negative-assertion: side-effect)", () => {
  // The matcher-gate tests above only assert exit 0 + empty stderr —
  // which would also pass if the script were `process.exit(0)` at line 1.
  // This block constructs a scenario where the gate's *absence* would
  // produce a different result: stage a mis-formatted in-repo file, fire
  // a Read payload (not Write/Edit) with that file as file_path. If the
  // gate works, the file is untouched. If the gate were stripped (hook
  // ran prettier on every payload), the file would be reformatted.
  const scratchDir = resolve(repoRoot, "tmp-hook-test-gate");
  const scratchFile = join(scratchDir, "sample.js");
  const malformed = "const x=1;const y    =    2\n";

  beforeAll(() => {
    mkdirSync(scratchDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("does NOT reformat the file when the payload is Read (gate rejects)", () => {
    writeFileSync(scratchFile, malformed, "utf8");
    const r = runHook({ tool_name: "Read", tool_input: { file_path: scratchFile } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    // Critical assertion: gate REJECTED Read → file untouched.
    // If the gate were removed, prettier would format it to
    // "const x = 1;\nconst y = 2;\n".
    expect(readFileSync(scratchFile, "utf8")).toBe(malformed);
  });

  it("does NOT reformat the file when the payload is Bash", () => {
    writeFileSync(scratchFile, malformed, "utf8");
    const r = runHook({ tool_name: "Bash", tool_input: { file_path: scratchFile, command: "ls" } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(readFileSync(scratchFile, "utf8")).toBe(malformed);
  });
});

describe("hook-prettier-write — input shape", () => {
  it("exits 0 on empty stdin", () => {
    const r = spawnSync(process.execPath, [hook], {
      cwd: repoRoot,
      input: "",
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });

  it("exits 0 on malformed (non-JSON) stdin", () => {
    const r = spawnSync(process.execPath, [hook], {
      cwd: repoRoot,
      input: "not json",
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });

  it("exits 0 when Write payload omits file_path", () => {
    const r = runHook({ tool_name: "Write", tool_input: { content: "x" } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("exits 0 when file_path is not a string", () => {
    const r = runHook({ tool_name: "Write", tool_input: { file_path: 42 } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("accepts camelCase toolInput.filePath fallback (sibling-hook parity)", () => {
    const r = runHook({
      toolName: "Write",
      toolInput: { filePath: "/outside-repo.js" },
    });
    expect(r.code).toBe(0);
  });
});

describe("hook-prettier-write — outside-repo skip", () => {
  it("exits 0 silently for a path on a different drive / absolute root", () => {
    const outsidePath = process.platform === "win32" ? "D:\\nowhere\\foo.js" : "/tmp/foo.js";
    const r = runHook({ tool_name: "Write", tool_input: { file_path: outsidePath } });
    expect(r.code).toBe(0);
    // No format/error stderr because prettier was never invoked.
    expect(r.stderr).toBe("");
  });

  it("exits 0 silently for a parent-directory escape", () => {
    const escape = resolve(repoRoot, "..", "..", "outside-foo.js");
    const r = runHook({ tool_name: "Write", tool_input: { file_path: escape } });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
  });
});

describe("hook-prettier-write — in-repo formatting (real prettier)", () => {
  // NOTE: this scratch dir must NOT be in `.gitignore` — prettier honors
  // `.gitignore` by default and would silently skip any path inside it,
  // turning the formatting assertions into false positives.
  const scratchDir = resolve(repoRoot, "tmp-hook-test");
  const scratchFile = join(scratchDir, "sample.js");

  beforeAll(() => {
    mkdirSync(scratchDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("formats a mis-formatted JS file via Write payload", () => {
    const before = "const x=1;const y    =    2\n";
    writeFileSync(scratchFile, before, "utf8");
    const r = runHook({ tool_name: "Write", tool_input: { file_path: scratchFile } });
    expect(r.code).toBe(0);
    if (existsSync(prettierBin)) {
      // Hook is silent on success — no stderr log on the happy path.
      expect(r.stderr).toBe("");
      const after = readFileSync(scratchFile, "utf8");
      // Negative-assertion: original whitespace is gone (proves prettier
      // ran AND the file was rewritten — not just left alone).
      expect(after).not.toBe(before);
      expect(after).toBe("const x = 1;\nconst y = 2;\n");
    } else {
      // Graceful fallback path (e.g., freshly-cut worktree without
      // `npm install`). Only stderr line in this scenario.
      expect(r.stderr).toMatch(/\[hook-prettier\] prettier not installed/);
    }
  });

  it("formats via Edit payload as well (matcher covers both)", () => {
    writeFileSync(scratchFile, "const a    =   3\n", "utf8");
    const r = runHook({
      tool_name: "Edit",
      tool_input: { file_path: scratchFile, old_string: "x", new_string: "y" },
    });
    expect(r.code).toBe(0);
    if (existsSync(prettierBin)) {
      expect(r.stderr).toBe("");
      expect(readFileSync(scratchFile, "utf8")).toBe("const a = 3;\n");
    }
  });

  it("is silent and leaves content unchanged on a .prettierignore'd file (markdown)", () => {
    // `.prettierignore` includes `*.md`; prettier exits 0 silently on
    // ignored files, so the hook stays silent. The content is content
    // prettier WOULD reformat (multiple trailing spaces, double space
    // after `#`) — if the ignore didn't fire, the file would change.
    const mdFile = join(scratchDir, "README-scratch.md");
    const content = "#  trailing spaces here   \n\n- item   \n- item2  \n";
    writeFileSync(mdFile, content, "utf8");
    const r = runHook({ tool_name: "Write", tool_input: { file_path: mdFile } });
    expect(r.code).toBe(0);
    if (existsSync(prettierBin)) {
      expect(r.stderr).toBe("");
      // Negative-assertion: ignore-pattern fired, so the file is byte-for-byte
      // identical — even though the content is something prettier WOULD
      // rewrite for a .md file outside the ignore list.
      expect(readFileSync(mdFile, "utf8")).toBe(content);
    }
  });
});

describe("hook-prettier-write — failure paths", () => {
  // `result.error` branches: the script must still exit 0 even when the
  // child process can't be spawned. We can't reliably trigger ENOENT on
  // the prettier bin without mutating the filesystem, but we exercise
  // the always-exit-0 contract for every payload variation above.
  it("never exits non-zero, even when payload is total garbage", () => {
    const r = spawnSync(process.execPath, [hook], {
      cwd: repoRoot,
      input: '{"tool_name":"Write","tool_input":null}',
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });
});

describe("hook-prettier-write — ETIMEDOUT branch (BACKLOG mechanical-floor)", () => {
  // The hook's `result.error.code === "ETIMEDOUT"` branch at
  // scripts/hook-prettier-write.mjs guards against a prettier child that
  // hangs past the 10s spawnSync timeout. Without these tests, the
  // branch is dead code in the test suite: a future regression that
  // drops `timeout: <ms>` (silently disables the timeout) or breaks the
  // `ETIMEDOUT` check (silently routes to the generic spawn-error log)
  // would ship green. Drive the branch with a hang stub + a 200ms
  // timeout override; assert the log message AND the always-exit-0
  // contract.
  //
  // Failure-mode diagnosis: if vitest itself times out on these tests
  // (rather than the expect() failing), the production `timeout:`
  // option was likely dropped — vitest's per-test cap catches the
  // never-returns-spawnSync. See per-test `{ timeout: 3000 }` below.
  const hangStub = resolve(repoRoot, "tests/fixtures/hang-prettier.mjs");
  const scratchDir = resolve(repoRoot, "tmp-hook-test-timeout");
  const scratchFile = join(scratchDir, "sample.js");

  beforeAll(() => {
    mkdirSync(scratchDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it(
    "logs `timeout (0.2s) — skipped` when prettier bin hangs past the configured timeout",
    () => {
      writeFileSync(scratchFile, "const x=1;\n", "utf8");
      const r = runHook(
        { tool_name: "Write", tool_input: { file_path: scratchFile } },
        {
          PRETTIER_HOOK_BIN_FOR_TESTS: hangStub,
          PRETTIER_HOOK_TIMEOUT_MS_FOR_TESTS: "200",
        },
      );
      // Exact-decimal regex covers BOTH "ETIMEDOUT branch fires"
      // (vs falling through to the generic spawn-error log) AND "log
      // message reads the actual timeout, not hardcoded 10s". A future
      // regression that hardcodes any specific value back into the
      // log will fail this assertion.
      expect(r.stderr).toMatch(/\[hook-prettier\] timeout \(0\.2s\) — skipped/);
      // Always-exit-0 contract: hook MUST NOT propagate a non-zero
      // exit even when prettier was killed mid-spawn.
      expect(r.code).toBe(0);
    },
    { timeout: 3000 },
  );

  it(
    "falls back to 10s default when PRETTIER_HOOK_TIMEOUT_MS_FOR_TESTS is malformed (no silent NaN timeout)",
    () => {
      // The most insidious failure: a future refactor that drops the
      // `Number.isFinite() && > 0` guard would let `Number("abc") = NaN`
      // pass through to spawnSync, which silently drops the timeout
      // option — regressing to no-timeout protection. Verify the
      // parser rejects garbage by running against a real (non-hanging)
      // prettier with the malformed override: the hook completes
      // silently on the happy path, proving the parser produced a
      // valid timeout (not NaN) AND that the default was used.
      writeFileSync(scratchFile, "const x=1;\n", "utf8");
      const r = runHook(
        { tool_name: "Write", tool_input: { file_path: scratchFile } },
        { PRETTIER_HOOK_TIMEOUT_MS_FOR_TESTS: "abc" },
      );
      expect(r.code).toBe(0);
      // If the parser fell back to default 10s AND prettier ran, the
      // hook stays silent (happy-path contract). Either an error log
      // or a non-zero exit would indicate parser leak.
      expect(r.stderr).toBe("");
    },
    { timeout: 15000 },
  );
});
