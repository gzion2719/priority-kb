// lib/admin-tags.test.ts — unit smoke for the catalog read.
//
// Full DB-bound coverage of role-relative entry_count lives in
// tests/tags.integration.test.ts. This file pins the shape of the export
// surface and the sensitivity-allow-list resolution wiring.

import { describe, expect, it } from "vitest";

import { sensitivityAllowedForRole } from "@/lib/auth";

import { listAdminTagsForRole, listRecentTagAuditRows } from "@/lib/admin-tags";

describe("lib/admin-tags exports", () => {
  it("exports listAdminTagsForRole as a function", () => {
    expect(typeof listAdminTagsForRole).toBe("function");
  });

  it("exports listRecentTagAuditRows as a function", () => {
    expect(typeof listRecentTagAuditRows).toBe("function");
  });
});

describe("sensitivity-allow-list parity with ADR-0025 D5", () => {
  // The catalog query filters by entries.sensitivity = ANY(sensitivityAllowedForRole(role)).
  // Pinning the role → allow-list here prevents drift between
  // lib/admin-tags's SQL and lib/auth's mapping. ADR-0012 §6 is the
  // authoritative source.
  it("admin sees all three sensitivities", () => {
    expect(sensitivityAllowedForRole("admin").sort()).toEqual(
      ["internal", "public", "restricted"].sort(),
    );
  });

  it("user sees public + internal, NOT restricted", () => {
    expect(sensitivityAllowedForRole("user").sort()).toEqual(["internal", "public"].sort());
    expect(sensitivityAllowedForRole("user")).not.toContain("restricted");
  });
});
