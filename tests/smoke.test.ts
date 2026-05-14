import { describe, it, expect } from "vitest";
import { brand } from "@/lib/brand";

describe("smoke", () => {
  it("resolves @/* alias and exposes brand metadata", () => {
    expect(brand.name).toBe("Priority Knowledge Base");
    expect(brand.tagline).toMatch(/Priority ERP/);
  });
});
