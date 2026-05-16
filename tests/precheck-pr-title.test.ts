import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const precheck = resolve(repoRoot, "scripts/precheck-pr-title.mjs");
const hook = resolve(repoRoot, "scripts/hook-gh-pr-create-precheck.mjs");

function check(title: string): { code: number; stderr: string } {
  const r = spawnSync(process.execPath, [precheck, title], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
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

describe("precheck-pr-title — historically-failing titles", () => {
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
    it(`rejects ${JSON.stringify(title)}`, () => {
      const { code } = check(title);
      expect(code).toBe(1);
    });
  }
});

describe("precheck-pr-title — valid titles", () => {
  const accepted = [
    "feat(scope): subject",
    'docs(protocol): step 7b — always run unbiased review before "go"',
    "release: dev → main (chatlog close: M1 first slice + autotitle floor)",
    "chore(deps)(deps-dev): bump foo from 1 to 2",
    "fix: redesign the API surface",
    "chore: update README and CONTRIBUTING",
  ];
  for (const title of accepted) {
    it(`accepts ${JSON.stringify(title)}`, () => {
      const { code, stderr } = check(title);
      expect(code, `stderr: ${stderr}`).toBe(0);
    });
  }
});

describe("precheck-pr-title — autotitle output", () => {
  it("accepts the autotitle workflow's default release title", () => {
    // .github/workflows/release-pr-autotitle.yml rewrites release-leg PRs to
    // exactly this string when the title doesn't start with `release:`.
    const { code, stderr } = check("release: dev → main");
    expect(code, `stderr: ${stderr}`).toBe(0);
  });

  it("accepts dependabot's double-scope title shape (empirically passes CI)", () => {
    // PRs #4–#12 demonstrate this shape passes amannn/action-semantic-pull-request.
    const { code, stderr } = check("chore(deps)(deps-dev): bump foo from 1 to 2");
    expect(code, `stderr: ${stderr}`).toBe(0);
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
