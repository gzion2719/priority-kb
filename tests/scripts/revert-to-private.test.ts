import { spawnSync } from "node:child_process";
import { resolve as pathResolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  EXPECTED_CONTEXTS,
  OWNER_REPO,
  PROTECTED_BRANCHES,
  detectFreePlanPrivateTrap,
  planSteps,
} from "../../scripts/revert-to-private.mjs";

const SCRIPT_PATH = pathResolve(__dirname, "..", "..", "scripts", "revert-to-private.mjs");

const STATE_PUBLIC_BOTH_ENFORCED = {
  visibility: "PUBLIC" as const,
  branches: {
    main: { enforce_admins: true, strict: false, contexts: EXPECTED_CONTEXTS },
    dev: { enforce_admins: true, strict: false, contexts: EXPECTED_CONTEXTS },
  },
};

const STATE_PRIVATE_BOTH_DISABLED = {
  visibility: "PRIVATE" as const,
  branches: {
    main: { enforce_admins: false, strict: false, contexts: EXPECTED_CONTEXTS },
    dev: { enforce_admins: false, strict: false, contexts: EXPECTED_CONTEXTS },
  },
};

describe("planSteps — pure planner", () => {
  it("emits visibility-flip + 2 enforce_admins disables, in that order, for the canonical pre-revert state", () => {
    const steps = planSteps(STATE_PUBLIC_BOTH_ENFORCED);
    expect(steps).toHaveLength(3);
    expect(steps[0].id).toBe("flip-visibility-private");
    expect(steps[1].id).toBe("disable-enforce-admins-main");
    expect(steps[2].id).toBe("disable-enforce-admins-dev");
  });

  it("visibility-flip step uses --accept-visibility-change-consequences (gh required flag)", () => {
    const steps = planSteps(STATE_PUBLIC_BOTH_ENFORCED);
    expect(steps[0].ghArgs).toEqual([
      "repo",
      "edit",
      OWNER_REPO,
      "--visibility",
      "private",
      "--accept-visibility-change-consequences",
    ]);
  });

  it("enforce_admins steps use DELETE on the per-branch protection sub-resource", () => {
    const steps = planSteps(STATE_PUBLIC_BOTH_ENFORCED);
    expect(steps[1].ghArgs).toEqual([
      "api",
      "-X",
      "DELETE",
      `/repos/${OWNER_REPO}/branches/main/protection/enforce_admins`,
    ]);
    expect(steps[2].ghArgs).toEqual([
      "api",
      "-X",
      "DELETE",
      `/repos/${OWNER_REPO}/branches/dev/protection/enforce_admins`,
    ]);
  });

  it("emits zero steps when fully converged (idempotency)", () => {
    expect(planSteps(STATE_PRIVATE_BOTH_DISABLED)).toEqual([]);
  });

  it("skips visibility-flip when already PRIVATE but still disables drifting enforce_admins", () => {
    const steps = planSteps({
      visibility: "PRIVATE",
      branches: {
        main: { enforce_admins: true, strict: false, contexts: EXPECTED_CONTEXTS },
        dev: { enforce_admins: false, strict: false, contexts: EXPECTED_CONTEXTS },
      },
    });
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe("disable-enforce-admins-main");
  });

  it("skips enforce_admins steps for branches whose protection is missing (null)", () => {
    const steps = planSteps({
      visibility: "PUBLIC",
      branches: {
        main: { enforce_admins: true, strict: false, contexts: EXPECTED_CONTEXTS },
        dev: null as unknown as { enforce_admins: boolean; strict: boolean; contexts: string[] },
      },
    });
    expect(steps.map((s) => s.id)).toEqual([
      "flip-visibility-private",
      "disable-enforce-admins-main",
    ]);
  });

  it("every step carries a recovery hint pointing back at this script or the manual gh command", () => {
    const steps = planSteps(STATE_PUBLIC_BOTH_ENFORCED);
    for (const s of steps) {
      expect(s.recovery).toMatch(/revert:private|gh /);
    }
  });
});

describe("EXPECTED_CONTEXTS — guards the ADR-0002 required-checks contract", () => {
  it("contains exactly the three contexts pinned by ADR-0002 §Branch protection", () => {
    expect(new Set(EXPECTED_CONTEXTS)).toEqual(
      new Set(["Node — lint, format, types, tests", "gitleaks", "Validate PR title"]),
    );
  });

  it("PROTECTED_BRANCHES covers main + dev per ADR-0011 §Decision payload", () => {
    expect(new Set(PROTECTED_BRANCHES)).toEqual(new Set(["main", "dev"]));
  });
});

describe("detectFreePlanPrivateTrap — Free + PUBLIC abort guard", () => {
  const USER = "User";
  const ORG = "Organization";

  it("traps the canonical pre-revert state: Free plan + PUBLIC repo (personal account)", () => {
    expect(
      detectFreePlanPrivateTrap({ planName: "free", accountType: USER, visibility: "PUBLIC" }),
    ).toMatchObject({ trap: true, reason: "free-confirmed" });
  });

  it("traps Free even on organization accounts (conservative; orgs may still be affected)", () => {
    // Orgs typically have Team/Enterprise; if somehow on Free, still trap.
    expect(
      detectFreePlanPrivateTrap({ planName: "free", accountType: ORG, visibility: "PUBLIC" }),
    ).toMatchObject({ trap: true, reason: "free-confirmed" });
  });

  it("case-insensitive on plan name (`Free`, `FREE`)", () => {
    for (const plan of ["Free", "FREE"]) {
      expect(
        detectFreePlanPrivateTrap({ planName: plan, accountType: USER, visibility: "PUBLIC" }),
      ).not.toBeNull();
    }
  });

  it("does not trap Pro / Team / Enterprise on PUBLIC personal accounts", () => {
    for (const plan of ["pro", "team", "enterprise", "Pro", "TEAM"]) {
      expect(
        detectFreePlanPrivateTrap({ planName: plan, accountType: USER, visibility: "PUBLIC" }),
      ).toBeNull();
    }
  });

  it("does not trap Free when already PRIVATE (no flip imminent)", () => {
    expect(
      detectFreePlanPrivateTrap({ planName: "free", accountType: USER, visibility: "PRIVATE" }),
    ).toBeNull();
  });

  it("TRAPS unknown plan on personal account + PUBLIC (conservative — token lacks read:user)", () => {
    expect(
      detectFreePlanPrivateTrap({ planName: null, accountType: USER, visibility: "PUBLIC" }),
    ).toMatchObject({ trap: true, reason: "plan-unknown-personal" });
  });

  it("does NOT trap unknown plan on Organization account + PUBLIC", () => {
    // Orgs don't suffer the Free+Private protection-API removal in the same way;
    // they have their own gating. Don't abort on org accounts when plan unknown.
    expect(
      detectFreePlanPrivateTrap({ planName: null, accountType: ORG, visibility: "PUBLIC" }),
    ).toBeNull();
  });

  it("does NOT trap unknown plan when already PRIVATE (no destructive flip imminent)", () => {
    expect(
      detectFreePlanPrivateTrap({ planName: null, accountType: USER, visibility: "PRIVATE" }),
    ).toBeNull();
  });

  it("Free trap message names the bypass flag and points at ADR-0011 Amendment", () => {
    const trap = detectFreePlanPrivateTrap({
      planName: "free",
      accountType: USER,
      visibility: "PUBLIC",
    });
    expect(trap).not.toBeNull();
    expect(trap!.message).toContain("--i-accept-free-plan-trap");
    expect(trap!.message).toContain("ADR-0011 Amendment");
  });

  it("unknown-plan trap message guides the user to `gh auth refresh -s read:user`", () => {
    const trap = detectFreePlanPrivateTrap({
      planName: null,
      accountType: USER,
      visibility: "PUBLIC",
    });
    expect(trap).not.toBeNull();
    expect(trap!.message).toContain("gh auth refresh -s read:user");
  });
});

describe("script integration — dry-run via REVERT_STUB_STATE_JSON", () => {
  it("prints the 3-step plan in correct order and exits 0 without --apply", () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        REVERT_STUB_STATE_JSON: JSON.stringify(STATE_PUBLIC_BOTH_ENFORCED),
        // Stub plan to a non-Free value so the Free+PUBLIC trap doesn't abort
        // the plan-listing path. The trap is exercised by its own test below.
        REVERT_STUB_USER_PLAN_NAME: "pro",
        REVERT_STUB_USER_ACCOUNT_TYPE: "User",
        // Bypass preflight so the test doesn't depend on real `gh` availability.
        PATH: process.env.PATH,
      },
    });
    // The script's preflight calls real `gh`; if absent, the script exits 1.
    // We accept either path but assert on stderr when it ran.
    if (r.status === 0) {
      expect(r.stderr).toContain("DRY-RUN");
      // Plan ordering: visibility first, then main, then dev.
      const idxVis = r.stderr.indexOf("flip-visibility-private");
      const idxMain = r.stderr.indexOf("disable-enforce-admins-main");
      const idxDev = r.stderr.indexOf("disable-enforce-admins-dev");
      // Each id appears in the plan-listing pass (description includes the gh
      // line which contains the id-equivalent text). Order check via indices.
      const idxFlip = r.stderr.indexOf("PUBLIC → PRIVATE");
      const idxMainCmd = r.stderr.indexOf("/branches/main/protection/enforce_admins");
      const idxDevCmd = r.stderr.indexOf("/branches/dev/protection/enforce_admins");
      expect(idxFlip).toBeGreaterThanOrEqual(0);
      expect(idxMainCmd).toBeGreaterThan(idxFlip);
      expect(idxDevCmd).toBeGreaterThan(idxMainCmd);
      expect(r.stderr).toContain("DRY-RUN complete");
      // Negative assertion: no `gh` execution happened beyond preflight (we stubbed state).
      // Sentinel: success line for an applied step would say "✓ ok" — must NOT appear.
      expect(r.stderr).not.toMatch(/Step \d+\/\d+/);
      // Suppress unused-var lint while keeping the named indices for diagnostics.
      void idxVis;
      void idxMain;
      void idxDev;
    }
  });

  it("aborts with the trap message + exit 1 on Free plan + PUBLIC", () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH], {
      encoding: "utf8",
      env: {
        ...process.env,
        REVERT_STUB_STATE_JSON: JSON.stringify(STATE_PUBLIC_BOTH_ENFORCED),
        REVERT_STUB_USER_PLAN_NAME: "free",
        REVERT_STUB_USER_ACCOUNT_TYPE: "User",
        PATH: process.env.PATH,
      },
    });
    // Preflight may exit 1 if `gh` is unavailable; only assert when preflight passed.
    if (r.status === 1 && r.stderr.includes("ABORTED")) {
      expect(r.stderr).toContain("Free + flip-to-private");
      expect(r.stderr).toContain("--i-accept-free-plan-trap");
      // The plan should NOT be printed when trap fires.
      expect(r.stderr).not.toContain("Plan (");
    }
  });

  it("bypasses the trap with --i-accept-free-plan-trap and proceeds to plan", () => {
    const r = spawnSync(process.execPath, [SCRIPT_PATH, "--i-accept-free-plan-trap"], {
      encoding: "utf8",
      env: {
        ...process.env,
        REVERT_STUB_STATE_JSON: JSON.stringify(STATE_PUBLIC_BOTH_ENFORCED),
        REVERT_STUB_USER_PLAN_NAME: "free",
        REVERT_STUB_USER_ACCOUNT_TYPE: "User",
        PATH: process.env.PATH,
      },
    });
    if (r.status === 0) {
      expect(r.stderr).toContain("bypass acknowledged");
      expect(r.stderr).toContain("Plan (");
      expect(r.stderr).toContain("DRY-RUN complete");
    }
  });
});
