#!/usr/bin/env node
// scripts/check-repo-public-banner.mjs
//
// Warns when the repository is PUBLIC. Reminder of the ADR-0011 revert
// trigger ("before any real Priority ERP content lands in the DB").
//
// Warn-only; never fails the gate. Silent under CI=true (the rule's
// purpose is to nudge the developer at local gate-time; CI noise isn't
// actionable). See docs/adr/0011-repo-visibility.md.

import { execSync } from "node:child_process";

if (process.env.CI) {
  process.exit(0);
}

try {
  const visibility = execSync("gh repo view --json visibility -q .visibility", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

  if (visibility === "PUBLIC") {
    const bar = "═".repeat(72);
    console.warn("");
    console.warn(bar);
    console.warn("  ⚠️  REPO IS PUBLIC — ADR-0011 revert trigger reminder");
    console.warn("");
    console.warn("  Flipped 2026-05-19 to unblock GitHub Actions billing.");
    console.warn("  Revert to PRIVATE before any of these fire:");
    console.warn("    (a) M2a item 8 (manual smoke with real entries) starts");
    console.warn("    (b) Real Priority content lands in any DB");
    console.warn("    (c) 2026-06-15 — hard date floor");
    console.warn("");
    console.warn("  See docs/adr/0011-repo-visibility.md.");
    console.warn(bar);
    console.warn("");
  }
} catch {
  // gh CLI unavailable or unauthenticated — silent, don't disrupt local dev.
}
