import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AGENT_TOOLS,
  LIST_CATEGORIES_TOOL,
  SEARCH_KB_TOOL,
  SUBMIT_ENTRY_TOOL,
} from "./agents-tools";
import { IngestBody } from "./ingest-schema";
import { sensitivityEnum } from "@/drizzle/schema";

describe("AGENT_TOOLS registry — shape + content", () => {
  it("contains exactly three tools, no duplicates", () => {
    expect(AGENT_TOOLS).toHaveLength(3);
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(3);
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
