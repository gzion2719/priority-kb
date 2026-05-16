// Conventional Commits config — single source of truth for both PR titles
// (.github/workflows/pr-title.yml) and commit messages (.pre-commit-config.yaml
// commit-msg hook). Also used by scripts/precheck-pr-title.mjs, which is
// invoked by the Claude Code PreToolUse Bash hook for `gh pr create`.
//
// See docs/adr/0004-pr-title-mechanical-floor.md.
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "chore", "docs", "refactor", "test", "ci", "release"],
    ],
    // Reject any subject whose first char is uppercase. "sentence-case"
    // (added 2026-05-16) is the rule that catches the leading-uppercase
    // failure that recurred on PRs #18 / #20 / #25 / #31. Aligns commitlint
    // with .github/workflows/pr-title.yml's subjectPattern ^(?![A-Z]).+$.
    "subject-case": [2, "never", ["upper-case", "pascal-case", "start-case", "sentence-case"]],
    "header-max-length": [2, "always", 100],
  },
};
