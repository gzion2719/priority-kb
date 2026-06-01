import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AGENT_TOOLS,
  LIST_CATEGORIES_TOOL,
  LIST_TAGS_TOOL,
  SEARCH_KB_TOOL,
  SUBMIT_ENTRY_TOOL,
} from "./agents-tools";
import { IngestBody } from "./ingest-schema";
import { sensitivityEnum } from "@/drizzle/schema";

describe("AGENT_TOOLS registry — shape + content", () => {
  it("contains exactly four tools, no duplicates", () => {
    expect(AGENT_TOOLS).toHaveLength(4);
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(4);
    // Negative-assertion: the four names are exactly the expected set.
    // Catches a drift where someone renames a tool but keeps the count.
    expect(new Set(names)).toEqual(
      new Set(["submit_entry", "list_categories", "search_kb", "list_tags"]),
    );
  });

  it("each tool has a non-empty description (LLM consumes this)", () => {
    for (const t of AGENT_TOOLS) {
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("each tool's input_schema is type:object with additionalProperties:false", () => {
    for (const t of AGENT_TOOLS) {
      const s = t.input_schema as { type: string; additionalProperties: boolean };
      expect(s.type).toBe("object");
      expect(s.additionalProperties).toBe(false);
    }
  });
});

describe("submit_entry tool — JSON Schema mirrors IngestBody", () => {
  it("name is the expected literal", () => {
    expect(SUBMIT_ENTRY_TOOL.name).toBe("submit_entry");
  });

  it("required[] equals the Zod-derived required-fields list — drift floor against IngestBody (lib/ingest-schema.ts)", () => {
    // Derive expected required[] from IngestBody by filtering out fields
    // that are `.optional()` / `.default(...)` — Zod considers both as
    // "may be undefined at parse time" via `isOptional()`. A future Zod
    // edit that adds a NON-defaulted field forces this test to fail,
    // catching the drift before step-3's submit_entry handler hits a
    // safeParse error on a missing field.
    const expectedRequired = Object.keys(IngestBody.shape).filter((k) => {
      const field = IngestBody.shape[k as keyof typeof IngestBody.shape] as z.ZodTypeAny;
      return !field.isOptional();
    });
    const schemaRequired = (SUBMIT_ENTRY_TOOL.input_schema as { required: readonly string[] })
      .required;
    expect([...schemaRequired].sort()).toEqual([...expectedRequired].sort());
  });

  it("properties[] covers every IngestBody key (drift floor for optional-field omission)", () => {
    // Even optional Zod fields must appear in properties so the agent can
    // pass them. The required[] check above only catches required-field
    // drift; this catches "Zod field exists but tool schema forgot it".
    const expectedKeys = Object.keys(IngestBody.shape).sort();
    const schemaKeys = Object.keys(
      (SUBMIT_ENTRY_TOOL.input_schema as { properties: Record<string, unknown> }).properties,
    ).sort();
    expect(schemaKeys).toEqual(expectedKeys);
  });

  it("sensitivity enum is sourced from drizzle/schema.ts sensitivityEnum (iron rule #6 single source of truth)", () => {
    const props = (
      SUBMIT_ENTRY_TOOL.input_schema as {
        properties: { sensitivity: { enum: readonly string[] } };
      }
    ).properties;
    expect([...props.sensitivity.enum]).toEqual([...sensitivityEnum]);
  });

  it("last_verified_at is format:date-time string (string-on-wire; Zod transforms to Date at parse time)", () => {
    const props = (
      SUBMIT_ENTRY_TOOL.input_schema as {
        properties: { last_verified_at: { type: string; format: string } };
      }
    ).properties;
    expect(props.last_verified_at.type).toBe("string");
    expect(props.last_verified_at.format).toBe("date-time");
  });
});

describe("list_categories tool", () => {
  it("name is the expected literal", () => {
    expect(LIST_CATEGORIES_TOOL.name).toBe("list_categories");
  });

  it("input schema has no properties (input is empty)", () => {
    const props = (LIST_CATEGORIES_TOOL.input_schema as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(props)).toEqual([]);
  });
});

describe("search_kb tool", () => {
  it("name is the expected literal", () => {
    expect(SEARCH_KB_TOOL.name).toBe("search_kb");
  });

  it("requires a `query` string", () => {
    const s = SEARCH_KB_TOOL.input_schema as {
      properties: { query: { type: string } };
      required: readonly string[];
    };
    expect(s.properties.query.type).toBe("string");
    expect([...s.required]).toEqual(["query"]);
  });
});

describe("list_tags tool (M4 #4 PR-C — ADR-0025 D5)", () => {
  it("name is the expected literal", () => {
    expect(LIST_TAGS_TOOL.name).toBe("list_tags");
  });

  it("input schema has an optional `prefix` string (no required[])", () => {
    const s = LIST_TAGS_TOOL.input_schema as {
      properties: { prefix: { type: string } };
      required?: readonly string[];
      additionalProperties: boolean;
    };
    expect(s.properties.prefix.type).toBe("string");
    // No required[] (or empty) — prefix is optional per D5.
    expect(s.required ?? []).toEqual([]);
    expect(s.additionalProperties).toBe(false);
  });

  it("description mentions canonical-name reuse (prose floor per Amendment 2026-06-01 §M5)", () => {
    // Negative-assertion against future prompt-content drift: the
    // description text is what the LLM consumes to decide when to call
    // list_tags and how to interpret the result. Loss of the "canonical
    // name" guidance silently regresses the prose floor.
    expect(LIST_TAGS_TOOL.description.toLowerCase()).toContain("canonical");
  });

  it("description has no length cap mentioned (B1 plan-CR fix: D5 specifies no cap)", () => {
    // Negative-assertion: a future edit that re-introduces a length cap
    // in the description (e.g. "prefix ≤ 64 chars") would silently regress
    // the B1 decision. The tool's prefix is uncapped by design.
    expect(LIST_TAGS_TOOL.description).not.toMatch(/≤\s*\d+\s*char|max\s*\d+\s*char/i);
  });
});
