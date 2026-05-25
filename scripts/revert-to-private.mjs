#!/usr/bin/env node
// scripts/revert-to-private.mjs
//
// Executes the ADR-0011 revert: flip repo visibility PUBLIC → PRIVATE and
// drop `enforce_admins: true` (set during the public window) back to
// `false` per ADR-0002 §"Branch protection" solo-repo rationale.
//
// Default mode is DRY-RUN. Pass `--apply` to execute. Idempotent: re-runs
// against a partially-converged state heal only what's still drifting.
//
// Cross-refs:
//   - docs/adr/0011-repo-visibility.md (the ADR being executed)
//   - docs/adr/0002-branching-and-merge-policy.md §"Branch protection"
//   - scripts/check-repo-public-banner.mjs (paired local-gate reminder)

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const OWNER_REPO = "gzion2719/priority-kb";
export const PROTECTED_BRANCHES = ["main", "dev"];
// Pinned to ADR-0011 §Decision payload. If ADR-0002 adds/removes a required
// context, update both this constant and the verification step. Mismatch is
// load-bearing: a missing context here makes verification spuriously fail;
// an extra context here makes the surgical DELETE silently leave drift.
export const EXPECTED_CONTEXTS = [
  "Node — lint, format, types, tests",
  "gitleaks",
  "Validate PR title",
];
export const EXPECTED_STRICT = false; // ADR-0002 §"Required-checks `strict` policy" amended 2026-05-20.
const ADR_PATH = pathResolve(__dirname, "..", "docs", "adr", "0011-repo-visibility.md");
const EXECUTED_HEADER = "## Amendment — Revert executed";

/**
 * Pure planner. Given current state, returns the ordered list of state-changing
 * gh invocations needed to reach the target (PRIVATE + enforce_admins:false
 * on every PROTECTED_BRANCH). Returns an empty array when already converged.
 *
 * Verification is NOT included — it runs post-execute against re-read state.
 *
 * @param {{
 *   visibility: "PUBLIC"|"PRIVATE",
 *   branches: Record<string, {enforce_admins: boolean, strict?: boolean, contexts?: string[]} | null>
 * }} currentState
 * @returns {Array<{id: string, description: string, ghArgs: string[], recovery: string}>}
 */
export function planSteps(currentState) {
  const steps = [];

  if (currentState.visibility === "PUBLIC") {
    steps.push({
      id: "flip-visibility-private",
      description: "Flip repo visibility PUBLIC → PRIVATE.",
      ghArgs: [
        "repo",
        "edit",
        OWNER_REPO,
        "--visibility",
        "private",
        "--accept-visibility-change-consequences",
      ],
      recovery: `Re-run \`npm run revert:private -- --apply\`. Or manually: \`gh repo edit ${OWNER_REPO} --visibility private --accept-visibility-change-consequences\`.`,
    });
  }

  for (const branch of PROTECTED_BRANCHES) {
    const b = currentState.branches[branch];
    if (!b) continue; // branch not protected → nothing to disable
    if (b.enforce_admins === true) {
      steps.push({
        id: `disable-enforce-admins-${branch}`,
        description: `Disable enforce_admins on \`${branch}\` (DELETE → enforce_admins.enabled=false).`,
        ghArgs: [
          "api",
          "-X",
          "DELETE",
          `/repos/${OWNER_REPO}/branches/${branch}/protection/enforce_admins`,
        ],
        recovery: `Re-run \`npm run revert:private -- --apply\` (idempotent — visibility-flip is skipped if already private). Or manually: \`gh api -X DELETE /repos/${OWNER_REPO}/branches/${branch}/protection/enforce_admins\`.`,
      });
    }
  }

  return steps;
}

function runGh(args, { allowFailure = false } = {}) {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  if (r.error) {
    if (allowFailure) return { ok: false, stdout: "", stderr: String(r.error) };
    throw new Error(`gh ${args.join(" ")} failed to spawn: ${r.error}`);
  }
  if (r.status !== 0 && !allowFailure) {
    throw new Error(`gh ${args.join(" ")} exited ${r.status}: ${(r.stderr || "").trim()}`);
  }
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function readCurrentState() {
  // Test hook: REVERT_STUB_STATE_JSON lets the dry-run integration test drive
  // the planner without touching the real `gh`. Production paths never set it.
  const stub = process.env.REVERT_STUB_STATE_JSON;
  if (stub) {
    return JSON.parse(stub);
  }
  const viz = runGh(["repo", "view", OWNER_REPO, "--json", "visibility", "-q", ".visibility"]);
  const visibility = viz.stdout.trim();
  const branches = {};
  for (const branch of PROTECTED_BRANCHES) {
    const r = runGh(["api", `/repos/${OWNER_REPO}/branches/${branch}/protection`], {
      allowFailure: true,
    });
    if (!r.ok) {
      branches[branch] = null;
      continue;
    }
    const protection = JSON.parse(r.stdout);
    branches[branch] = {
      enforce_admins: protection.enforce_admins?.enabled === true,
      strict: protection.required_status_checks?.strict === true,
      contexts: protection.required_status_checks?.contexts ?? [],
    };
  }
  return { visibility, branches };
}

/**
 * Detects the GitHub-Free-plan + private-repo branch-protection trap.
 *
 * GitHub Free does NOT expose the branches/{branch}/protection REST API on
 * private personal-account repositories — GET and DELETE both return 403
 * "Upgrade to GitHub Pro or make this repository public to enable this
 * feature." Flipping a public repo to private under Free **wipes existing
 * protection rules** with no way to re-apply via API.
 *
 * If we detect this combination at script-time, abort BEFORE the visibility
 * flip. Discovered the hard way 2026-05-25; see ADR-0011 Amendment.
 *
 * Pure function — caller supplies `planName` (`gh api user --jq .plan.name`,
 * may be null when the token lacks the `read:user` scope), `accountType`
 * (`gh api user --jq .type` → "User"|"Organization"), and `visibility`.
 * Returns null when safe; returns an Error-shaped object when the operation
 * would trap the user OR when we cannot confirm it would not.
 *
 * Conservative default: unknown plan + personal account + PUBLIC → trap.
 * Orgs and known Pro/Team/Enterprise plans proceed clean.
 *
 * @param {{planName: string|null, accountType: string|null, visibility: "PUBLIC"|"PRIVATE"}} input
 * @returns {{trap: true, reason: "free-confirmed"|"plan-unknown-personal", message: string}|null}
 */
export function detectFreePlanPrivateTrap({ planName, accountType, visibility }) {
  if (visibility !== "PUBLIC") return null;
  const isFree = typeof planName === "string" && planName.toLowerCase() === "free";
  const isOrg = accountType === "Organization";
  const planKnownSafe =
    typeof planName === "string" && ["pro", "team", "enterprise"].includes(planName.toLowerCase());

  if (isFree) {
    return {
      trap: true,
      reason: "free-confirmed",
      message: [
        "GitHub Free + flip-to-private would WIPE branch protection.",
        "",
        "GitHub Free does not expose the branches/.../protection REST API on",
        "private personal-account repos. Flipping this repo to PRIVATE will",
        "auto-remove the ADR-0002 §Decision protection rules with no API path",
        "to restore them. The mechanical hooks (hook-gh-pr-create-precheck,",
        "hook-gh-pr-merge-block) would become the ONLY floor.",
        "",
        "Options:",
        "  1. Stay PUBLIC (the cost-trim wave 1 already shipped 2026-05-21,",
        "     and wave 2 trims are queued in BACKLOG).",
        "  2. Upgrade to GitHub Pro (~$4/month), then re-run this script.",
        "  3. Accept unmanaged protection on private + only-mechanical-hooks-",
        "     as-floor, then bypass this check with --i-accept-free-plan-trap.",
        "",
        "See ADR-0011 Amendment 2026-05-25 — Free-plan private trap.",
      ].join("\n"),
    };
  }

  if (!planKnownSafe && !isOrg) {
    return {
      trap: true,
      reason: "plan-unknown-personal",
      message: [
        "Cannot confirm GitHub plan tier — refusing to flip a personal repo to PRIVATE.",
        "",
        "`gh api user --jq .plan.name` returned no plan (token likely lacks the",
        "`read:user` scope). GitHub Free wipes private-repo branch protection",
        "irreversibly, so this script refuses to proceed without confirming you",
        "are on Pro+.",
        "",
        "Options:",
        "  1. Refresh gh scope and retry:",
        "       gh auth refresh -s read:user",
        "       npm run revert:private -- --apply",
        "  2. If you know you are on Pro/Team/Enterprise, bypass this check:",
        "       npm run revert:private -- --apply --i-accept-free-plan-trap",
        "  3. Stay PUBLIC.",
        "",
        "See ADR-0011 Amendment 2026-05-25 — Free-plan private trap.",
      ].join("\n"),
    };
  }

  return null;
}

function readUserContext() {
  const planStub = process.env.REVERT_STUB_USER_PLAN_NAME;
  const typeStub = process.env.REVERT_STUB_USER_ACCOUNT_TYPE;
  if (planStub !== undefined || typeStub !== undefined) {
    return {
      planName: planStub !== undefined ? planStub || null : null,
      accountType: typeStub !== undefined ? typeStub || null : null,
    };
  }
  const planR = runGh(["api", "user", "--jq", ".plan.name"], { allowFailure: true });
  const typeR = runGh(["api", "user", "--jq", ".type"], { allowFailure: true });
  return {
    planName: planR.ok ? planR.stdout.trim() || null : null,
    accountType: typeR.ok ? typeR.stdout.trim() || null : null,
  };
}

function preflight() {
  const v = runGh(["--version"], { allowFailure: true });
  if (!v.ok) {
    console.error("✗ `gh` CLI not found or not runnable. Install GitHub CLI first.");
    process.exit(1);
  }
  console.error(`  gh version: ${v.stdout.split("\n")[0]}`);
  const auth = runGh(["auth", "status"], { allowFailure: true });
  if (!auth.ok) {
    console.error("✗ `gh auth status` failed. Run `gh auth login` first.");
    console.error(auth.stderr);
    process.exit(1);
  }
  // Open-PRs warn-only check. This PR itself will be open when the script runs
  // against its own merge; we don't block, we just surface.
  const prs = runGh(["pr", "list", "--state", "open", "--json", "number,headRefName,title"], {
    allowFailure: true,
  });
  if (prs.ok && prs.stdout.trim()) {
    try {
      const list = JSON.parse(prs.stdout);
      if (Array.isArray(list) && list.length > 0) {
        console.error("");
        console.error(
          `  ⚠️  ${list.length} open PR(s) — protection-rule change may briefly affect mergeability:`,
        );
        for (const pr of list) {
          console.error(`    #${pr.number} ${pr.headRefName}: ${pr.title}`);
        }
        console.error("");
      }
    } catch {
      // ignore malformed pr-list output
    }
  }
}

function verifyPostState() {
  const state = readCurrentState();
  const problems = [];
  if (state.visibility !== "PRIVATE") {
    problems.push(`visibility is ${state.visibility}, expected PRIVATE`);
  }
  for (const branch of PROTECTED_BRANCHES) {
    const b = state.branches[branch];
    if (!b) {
      problems.push(
        `branch \`${branch}\`: protection missing entirely (404). Expected ADR-0002 protection in place.`,
      );
      continue;
    }
    if (b.enforce_admins !== false) {
      problems.push(
        `branch \`${branch}\`: enforce_admins.enabled is ${b.enforce_admins}, expected false`,
      );
    }
    if (b.strict !== EXPECTED_STRICT) {
      problems.push(
        `branch \`${branch}\`: required_status_checks.strict is ${b.strict}, expected ${EXPECTED_STRICT}`,
      );
    }
    const contextsSorted = [...b.contexts].sort();
    const expectedSorted = [...EXPECTED_CONTEXTS].sort();
    if (
      contextsSorted.length !== expectedSorted.length ||
      contextsSorted.some((c, i) => c !== expectedSorted[i])
    ) {
      problems.push(
        `branch \`${branch}\`: required_status_checks.contexts is ${JSON.stringify(b.contexts)}, expected ${JSON.stringify(EXPECTED_CONTEXTS)} (order-insensitive)`,
      );
    }
  }
  return { ok: problems.length === 0, problems, state };
}

function listForks() {
  const r = runGh(["api", `/repos/${OWNER_REPO}/forks`, "--jq", ".[].full_name"], {
    allowFailure: true,
  });
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function writeExecutedAmendment({ state, forks }) {
  let body;
  try {
    body = readFileSync(ADR_PATH, "utf8");
  } catch (err) {
    console.error(`✗ Failed to read ADR file ${ADR_PATH}: ${err.message}`);
    return;
  }
  if (body.includes(EXECUTED_HEADER)) {
    console.error(`  ADR already contains "${EXECUTED_HEADER}" — skipping writeback (idempotent).`);
    return;
  }
  const timestamp = new Date().toISOString();
  const branchSummaries = PROTECTED_BRANCHES.map((branch) => {
    const b = state.branches[branch];
    if (!b) return `- \`${branch}\`: protection missing (404)`;
    return `- \`${branch}\`: enforce_admins=${b.enforce_admins}, strict=${b.strict}, contexts=${JSON.stringify(b.contexts)}`;
  }).join("\n");
  const forksBlock =
    forks.length === 0
      ? "- No forks created during the public window."
      : forks.map((f) => `- \`${f}\``).join("\n");
  const block = [
    "",
    EXECUTED_HEADER,
    "",
    `- **Executed at:** ${timestamp}`,
    `- **Repository visibility:** PRIVATE`,
    `- **Post-state per branch:**`,
    branchSummaries,
    `- **Forks created during the public window:**`,
    forksBlock,
    `- **Tool:** \`scripts/revert-to-private.mjs\` (\`npm run revert:private -- --apply\`).`,
    "",
  ].join("\n");
  writeFileSync(ADR_PATH, body.trimEnd() + "\n" + block, "utf8");
  console.error(`  ADR appended with executed-state block.`);
}

async function main(argv) {
  const apply = argv.includes("--apply");
  const bypassFreeTrap = argv.includes("--i-accept-free-plan-trap");
  console.error(`revert-to-private (${apply ? "APPLY" : "DRY-RUN"})`);
  console.error("");
  preflight();
  console.error("");

  const currentState = readCurrentState();
  console.error(`  current visibility: ${currentState.visibility}`);
  for (const branch of PROTECTED_BRANCHES) {
    const b = currentState.branches[branch];
    if (!b) {
      console.error(`  ${branch}: protection MISSING (404)`);
    } else {
      console.error(
        `  ${branch}: enforce_admins=${b.enforce_admins} strict=${b.strict} contexts=${b.contexts.length}`,
      );
    }
  }
  console.error("");

  const { planName, accountType } = readUserContext();
  console.error(`  account type: ${accountType ?? "(unknown)"}  plan: ${planName ?? "(unknown)"}`);
  const trap = detectFreePlanPrivateTrap({
    planName,
    accountType,
    visibility: currentState.visibility,
  });
  if (trap) {
    if (bypassFreeTrap) {
      console.error("");
      console.error("⚠️  Free-plan private-trap bypass acknowledged (--i-accept-free-plan-trap).");
      console.error("    Proceeding; branch protection will be wiped and unrecoverable via API.");
    } else {
      console.error("");
      console.error("✗ ABORTED");
      console.error("");
      console.error(trap.message);
      process.exit(1);
    }
  }
  console.error("");

  const steps = planSteps(currentState);
  if (steps.length === 0) {
    console.error("✓ Already converged — no state-changing steps needed.");
    // Still verify in apply mode to confirm no hidden drift in strict/contexts.
    if (apply) {
      const v = verifyPostState();
      if (!v.ok) {
        console.error("✗ Post-state verification failed:");
        for (const p of v.problems) console.error(`  - ${p}`);
        process.exit(1);
      }
      console.error("✓ Verified: visibility=PRIVATE, all branches at expected protection state.");
    }
    return;
  }

  console.error(`Plan (${steps.length} step${steps.length === 1 ? "" : "s"}):`);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    console.error(`  ${i + 1}. ${s.description}`);
    console.error(`     gh ${s.ghArgs.join(" ")}`);
  }
  console.error("");

  if (!apply) {
    console.error("DRY-RUN complete. Pass `--apply` to execute:");
    console.error("  npm run revert:private -- --apply");
    return;
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    console.error(`→ Step ${i + 1}/${steps.length}: ${s.id}`);
    try {
      runGh(s.ghArgs);
      console.error(`  ✓ ok`);
    } catch (err) {
      console.error(`  ✗ FAILED: ${err.message}`);
      console.error(`  Recovery: ${s.recovery}`);
      process.exit(1);
    }
  }
  console.error("");

  console.error("Verifying post-state...");
  const v = verifyPostState();
  if (!v.ok) {
    console.error("✗ Post-state verification failed:");
    for (const p of v.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.error(
    "✓ Verified: visibility=PRIVATE, enforce_admins=false on all protected branches, strict+contexts unchanged.",
  );
  console.error("");

  const forks = listForks();
  if (forks.length > 0) {
    console.error(`  Forks created during the public window (${forks.length}):`);
    for (const f of forks) console.error(`    - ${f}`);
    console.error("  (Forks cannot be un-forked; reverting blocks future reads only.)");
  } else {
    console.error("  No forks created during the public window.");
  }
  console.error("");

  writeExecutedAmendment({ state: v.state, forks });
  console.error("");
  console.error("Done. Commit the ADR amendment block:");
  console.error("  git add docs/adr/0011-repo-visibility.md");
  console.error("  git commit -m 'docs(adr-0011): record revert execution'");
}

// Run when invoked directly (not when imported by tests).
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("revert-to-private.mjs")
) {
  main(process.argv.slice(2));
}
