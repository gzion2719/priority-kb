import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import lint from "@commitlint/lint";
import load from "@commitlint/load";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const precheck = resolve(repoRoot, "scripts/precheck-pr-title.mjs");
const hook = resolve(repoRoot, "scripts/hook-gh-pr-create-precheck.mjs");

// Loaded once via `beforeAll`. Mirrors the CLI commitlint config-loading path
// used by scripts/precheck-pr-title.mjs so the in-process lint() decisions
// match the spawned-CLI path exactly. See ADR-0004 for the gate architecture.
let config: Awaited<ReturnType<typeof load>>;

beforeAll(async () => {
  config = await load({}, { file: "commitlint.config.cjs", cwd: repoRoot });
});

async function lintTitle(title: string): Promise<{ valid: boolean }> {
  // Pass through every config surface that affects validation: rules,
  // parserOpts (for the parser preset), plugins (custom rule contributions),
  // ignores + defaultIgnores (short-circuit valid:true for matched patterns).
  // Today's commitlint.config.cjs sets none of plugins/ignores, but threading
  // them through future-proofs parity with the CLI path.
  // `@commitlint/load` types `parserPreset.parserOpts` as `unknown` because
  // the value is dynamically loaded from a string preset; `@commitlint/lint`
  // expects the conventional-commits parser-options shape. The cast bridges
  // them — the runtime value IS the right shape (PoC + tests confirm).
  const r = await lint(title, config.rules, {
    parserOpts: config.parserPreset?.parserOpts as NonNullable<
      Parameters<typeof lint>[2]
    >["parserOpts"],
    plugins: config.plugins,
    ignores: config.ignores,
    defaultIgnores: config.defaultIgnores,
  });
  return { valid: r.valid };
}

function runHook(payload: Record<string, unknown>): {
  code: number;
  stderr: string;
} {
  const r = spawnSync(process.execPath, [hook], {
    cwd: repoRoot,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

describe("commitlint config — historically-failing titles", () => {
  const rejected = [
    "Dev",
    "Pass 2b",
    'docs(protocol): Step 7b — always run unbiased review before "go"',
    "release: Dev → main",
    "Update README",
    "feat: TLS handshake bug",
    "feat: API design",
  ];
  for (const title of rejected) {
    it(`rejects ${JSON.stringify(title)}`, async () => {
      const { valid } = await lintTitle(title);
      expect(valid).toBe(false);
    });
  }
});

describe("commitlint config — valid titles", () => {
  it("accepts feat(scope): subject", async () => {
    expect((await lintTitle("feat(scope): subject")).valid).toBe(true);
  });

  it("accepts the docs(protocol) shape with em-dash and quoted go", async () => {
    expect(
      (await lintTitle('docs(protocol): step 7b — always run unbiased review before "go"')).valid,
    ).toBe(true);
  });

  it("accepts release-leg title with unicode arrow + parenthetical scope", async () => {
    // The unicode `→` is the regression-prone byte sequence — keep this case
    // explicitly named so a parser-preset misconfiguration produces a
    // diagnosable failure rather than a bundled-array generic message.
    expect(
      (await lintTitle("release: dev → main (chatlog close: M1 first slice + autotitle floor)"))
        .valid,
    ).toBe(true);
  });

  it("accepts dependabot's double-scope shape `chore(deps)(deps-dev):`", async () => {
    expect((await lintTitle("chore(deps)(deps-dev): bump foo from 1 to 2")).valid).toBe(true);
  });

  it("accepts fix: redesign the API surface", async () => {
    expect((await lintTitle("fix: redesign the API surface")).valid).toBe(true);
  });

  it("accepts chore: update README and CONTRIBUTING", async () => {
    expect((await lintTitle("chore: update README and CONTRIBUTING")).valid).toBe(true);
  });
});

describe("commitlint config — autotitle workflow output", () => {
  it("accepts the autotitle workflow's default release title", async () => {
    // .github/workflows/release-pr-autotitle.yml rewrites release-leg PRs to
    // exactly this string when the title doesn't start with `release:`.
    expect((await lintTitle("release: dev → main")).valid).toBe(true);
  });
});

describe("precheck-pr-title.mjs — script integration smoke", () => {
  // Two cases (one accepted, one rejected) — exit 0 and exit 1 are different
  // code paths in scripts/precheck-pr-title.mjs (lines 47-48 vs 51-54). The
  // hook tests below transitively spawn this same script with various titles,
  // but pinning each branch here keeps the integration coverage explicit and
  // would catch a regression in argv parsing or commitlint config-path
  // resolution even if all hook tests happened to drive only one branch.
  function spawnPrecheck(title: string): { code: number } {
    const r = spawnSync(process.execPath, [precheck, title], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return { code: r.status ?? -1 };
  }

  it("exits 1 on a known-bad title (Dev)", () => {
    expect(spawnPrecheck("Dev").code).toBe(1);
  });

  it("exits 0 on a known-good title (feat(scope): subject)", () => {
    expect(spawnPrecheck("feat(scope): subject").code).toBe(0);
  });
});

describe("hook-gh-pr-create-precheck — segment isolation (B1 regression)", () => {
  it("does NOT block an echo that merely mentions gh pr create as text", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: {
        command: 'echo "to open: gh pr create --title Foo"',
      },
    });
    expect(code).toBe(0);
  });

  it("does NOT block a commented-out gh pr create line", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: '# gh pr create --title "X"\nls' },
    });
    expect(code).toBe(0);
  });

  it("does NOT block when gh pr create appears inside a heredoc body", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: {
        command: 'cat <<EOF\nrun this manually: gh pr create --title "Anything"\nEOF',
      },
    });
    // The heredoc body becomes its own "segment" after newline split, but
    // it doesn't start with `gh pr create` after the leading content, so
    // the anchor rejects it. Allow exit 0.
    expect(code).toBe(0);
  });

  it("DOES block a real gh pr create with a bad title", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: {
        command: 'gh pr create --base dev --title "docs(protocol): Step 7b"',
      },
    });
    expect(code).toBe(2);
  });

  it("DOES block when a real gh pr create follows a cd && chain", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: {
        command: 'cd /tmp && gh pr create --base dev --title "Bad"',
      },
    });
    expect(code).toBe(2);
  });

  it("DOES block when env-var assignments precede gh", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: {
        command: 'GH_TOKEN=xxx FOO=bar gh pr create --base dev --title "Bad"',
      },
    });
    expect(code).toBe(2);
  });

  it("passes a real gh pr create with a good title", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: {
        command: 'gh pr create --base dev --title "docs(protocol): step 7b — refresh"',
      },
    });
    expect(code).toBe(0);
  });

  it("passes a gh pr create with no --title (gh will use commit message)", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: "gh pr create --base dev" },
    });
    expect(code).toBe(0);
  });

  it("passes a gh pr create with bare-unquoted --title (skips extraction)", () => {
    // Bare-unquoted --title is ambiguous; hook deliberately doesn't try to
    // extract it. The commit-msg hook + pr-title.yml gate still cover it.
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: "gh pr create --title Bar --base dev" },
    });
    expect(code).toBe(0);
  });

  it("ignores non-Bash tool calls", () => {
    const { code } = runHook({ tool_name: "Read", tool_input: {} });
    expect(code).toBe(0);
  });
});
