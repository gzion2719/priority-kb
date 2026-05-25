// Vitest spawns the hook via spawnSync with a controlled stdin payload; the
// hook is NOT actually firing on this test process's own Bash calls (the
// literal `gh pr merge` strings live inside JSON-stringified tool_input,
// not at the start of a Bash segment). No recursion risk.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const hook = resolve(repoRoot, "scripts/hook-gh-pr-merge-block.mjs");

function runHook(payload: Record<string, unknown>): { code: number; stderr: string } {
  const r = spawnSync(process.execPath, [hook], {
    cwd: repoRoot,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stderr: r.stderr ?? "" };
}

describe("hook-gh-pr-merge-block — blocks real gh pr merge invocations", () => {
  it("blocks bare `gh pr merge <num>`", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 258" },
    });
    expect(code).toBe(2);
  });

  it("blocks `gh pr merge --auto` and explains why in the message", () => {
    const { code, stderr } = runHook({
      tool_name: "Bash",
      tool_input: { command: "gh pr merge 258 --auto" },
    });
    expect(code).toBe(2);
    expect(stderr).toMatch(/--auto/);
    expect(stderr).toMatch(/PR #35/);
  });

  it("blocks `gh pr merge --merge --delete-branch <num>`", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: "gh pr merge --merge --delete-branch 258" },
    });
    expect(code).toBe(2);
  });

  it("blocks `gh pr merge` with no positional (uses current branch)", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: "gh pr merge --squash" },
    });
    expect(code).toBe(2);
  });

  it("blocks after a `cd && chain`", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: "cd /tmp && gh pr merge 1 --merge" },
    });
    expect(code).toBe(2);
  });

  it("blocks after env-var prefix", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: "GH_TOKEN=xxx gh pr merge 1 --merge" },
    });
    expect(code).toBe(2);
  });

  it("blocks `gh pr merge --help` (intentional — read --help in a separate shell)", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: "gh pr merge --help" },
    });
    expect(code).toBe(2);
  });
});

describe("hook-gh-pr-merge-block — segment isolation (does NOT block)", () => {
  it("does NOT block echo that mentions `gh pr merge` as text", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: 'echo "next step: gh pr merge 1 --merge"' },
    });
    expect(code).toBe(0);
  });

  it("does NOT block a commented-out gh pr merge line", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: "# gh pr merge 1 --merge\nls" },
    });
    expect(code).toBe(0);
  });

  it("does NOT block when gh pr merge appears inside a heredoc body", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: {
        command: "cat <<EOF\nrun this manually: gh pr merge 1 --merge\nEOF",
      },
    });
    expect(code).toBe(0);
  });
});

describe("hook-gh-pr-merge-block — sibling gh subcommands pass", () => {
  it("does NOT block `gh pr create`", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: 'gh pr create --base dev --title "feat(x): subject"' },
    });
    expect(code).toBe(0);
  });

  it("does NOT block `gh pr view`", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: "gh pr view 258" },
    });
    expect(code).toBe(0);
  });

  it("does NOT block `gh pr edit`", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: "gh pr edit 258 --add-label foo" },
    });
    expect(code).toBe(0);
  });

  it("does NOT block `gh issue create`", () => {
    const { code } = runHook({
      tool_name: "Bash",
      tool_input: { command: 'gh issue create --title "bug"' },
    });
    expect(code).toBe(0);
  });
});

describe("hook-gh-pr-merge-block — non-Bash and empty payloads", () => {
  it("ignores non-Bash tool calls", () => {
    const { code } = runHook({ tool_name: "Read", tool_input: {} });
    expect(code).toBe(0);
  });

  it("ignores empty Bash commands", () => {
    const { code } = runHook({ tool_name: "Bash", tool_input: { command: "" } });
    expect(code).toBe(0);
  });
});
