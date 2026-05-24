import { describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import {
  resolveRoleFromHeader,
  sensitivityAllowedForRole,
  withAdmin,
  withUserOrAdmin,
} from "@/lib/auth";
import type { AuthenticatedRouteHandler, Role } from "@/lib/auth";

function makeReq(headers?: Record<string, string>): NextRequest {
  // App Router's `NextRequest` is structurally a `Request` for our purposes
  // (headers, url, method); the cast keeps the test surface honest about
  // what the wrapper actually consumes.
  return new Request("http://x/admin-op", { headers }) as unknown as NextRequest;
}

describe("withAdmin — paired positive/negative (distinguishes from trivial impls)", () => {
  // If `withAdmin` were broken to `return handler(req, ctx)` always, the
  // user-path assertion `spy not called` would fail. If broken to
  // `return forbidden()` always, the admin-path `spy called once` would
  // fail. See WORKFLOW.md "Negative-assertion tests distinguish from
  // the regression".

  it("invokes handler with x-stub-user-role: admin", async () => {
    const spy = vi.fn(async () => new Response("ok", { status: 200 }));
    const wrapped = withAdmin(spy);

    const res = await wrapped(makeReq({ "x-stub-user-role": "admin" }), {});

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does NOT invoke handler with x-stub-user-role: user", async () => {
    const spy = vi.fn(async () => new Response("ok"));
    const wrapped = withAdmin(spy);

    const res = await wrapped(makeReq({ "x-stub-user-role": "user" }), {});

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("withAdmin — 401 unauthorized cases (uniform status+body assertions)", () => {
  // Note: ASCII-whitespace padding (e.g. "admin ") is normalized away by
  // the Fetch Headers spec on set/append — recipients never see it. No
  // in-helper trim is therefore needed or testable. See lib/auth.ts.

  it.each([
    { label: "missing header", build: () => makeReq() },
    { label: "empty-string value", build: () => makeReq({ "x-stub-user-role": "" }) },
    { label: "wrong-case 'Admin'", build: () => makeReq({ "x-stub-user-role": "Admin" }) },
    {
      label: "unknown role 'superuser'",
      build: () => makeReq({ "x-stub-user-role": "superuser" }),
    },
  ])(
    "rejects $label with 401 + Bearer realm='stub' + {error:'unauthorized'}",
    async ({ build }) => {
      const spy = vi.fn(async () => new Response("ok"));
      const wrapped = withAdmin(spy);

      const res = await wrapped(build(), {});

      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe('Bearer realm="stub"');
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("rejects comma-joined duplicate header 'admin, user' with 401", async () => {
    // When two `x-stub-user-role` headers are sent, the Web Headers spec
    // joins them with ", " on `.get()`. Strict match → ambiguous = reject.
    const headers = new Headers();
    headers.append("x-stub-user-role", "admin");
    headers.append("x-stub-user-role", "user");
    const req = new Request("http://x/admin-op", { headers }) as unknown as NextRequest;

    // Sanity: confirm the spec behavior we depend on before asserting on
    // the wrapper's response. If the Headers spec ever stops comma-joining,
    // this assertion catches the silent contract drift.
    expect(req.headers.get("x-stub-user-role")).toBe("admin, user");

    const spy = vi.fn(async () => new Response("ok"));
    const wrapped = withAdmin(spy);

    const res = await wrapped(req, {});

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="stub"');
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("withAdmin — header NAME is HTTP-standard case-insensitive (value is strict)", () => {
  // The property under test is "Headers normalizes the NAME on lookup,
  // not the value." Two non-canonical capitalizations of the name both
  // resolve to the same value; two capitalizations of the value do not.

  it.each([
    { label: "canonical 'X-Stub-User-Role'", name: "X-Stub-User-Role" },
    { label: "ALL-CAPS 'X-STUB-USER-ROLE'", name: "X-STUB-USER-ROLE" },
  ])("accepts admin via $label", async ({ name }) => {
    const spy = vi.fn(async () => new Response("ok"));
    const wrapped = withAdmin(spy);

    const res = await wrapped(makeReq({ [name]: "admin" }), {});

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("withAdmin — context arg and error propagation", () => {
  it("forwards the App Router context arg to the handler unchanged", async () => {
    // Locks the M1 fix from the code-CR: dynamic routes like
    // `app/api/items/[id]/route.ts` receive `{ params: Promise<...> }` as
    // the second arg; the wrapper must pass it through identity-equal.
    type Ctx = { params: Promise<{ id: string }> };
    const spy = vi.fn(async (_req: NextRequest, _ctx: Ctx) => new Response("ok"));
    const wrapped = withAdmin<Ctx>(spy);
    const ctx: Ctx = { params: Promise.resolve({ id: "42" }) };

    await wrapped(makeReq({ "x-stub-user-role": "admin" }), ctx);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toBe(ctx);
  });

  it("propagates handler rejections (does not swallow)", async () => {
    // A future "helpful" try/catch around handler(req, ctx) would convert
    // throws into 500s and silently change Next's error-page behavior.
    // This test pins the current contract: throws bubble up.
    const wrapped = withAdmin(async () => {
      throw new Error("boom");
    });

    await expect(wrapped(makeReq({ "x-stub-user-role": "admin" }), {})).rejects.toThrow("boom");
  });
});

describe("withUserOrAdmin — admits both recognized roles, rejects everything else", () => {
  // Twin of the withAdmin paired-positive/negative discipline. The
  // load-bearing distinguisher is the THIRD handler arg (role) — a broken
  // impl that always passed role="admin" would let users see restricted
  // entries via the downstream sensitivityAllowedForRole mapping. The
  // tests check role propagation, not just status code.

  it("invokes handler with role='admin' when x-stub-user-role: admin", async () => {
    // Typed spy signature so mock.calls[0] is the 3-tuple (req, ctx, role)
    // rather than vi.fn's default empty-tuple inference. Without this the
    // role-propagation assertion below would fail to type-check.
    const spy = vi.fn<AuthenticatedRouteHandler<unknown>>(
      async () => new Response("ok", { status: 200 }),
    );
    const wrapped = withUserOrAdmin(spy);

    const res = await wrapped(makeReq({ "x-stub-user-role": "admin" }), {});

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[2]).toBe("admin");
  });

  it("invokes handler with role='user' when x-stub-user-role: user", async () => {
    const spy = vi.fn<AuthenticatedRouteHandler<unknown>>(
      async () => new Response("ok", { status: 200 }),
    );
    const wrapped = withUserOrAdmin(spy);

    const res = await wrapped(makeReq({ "x-stub-user-role": "user" }), {});

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[2]).toBe("user");
  });

  it.each([
    { label: "missing header", build: () => makeReq() },
    { label: "empty-string value", build: () => makeReq({ "x-stub-user-role": "" }) },
    { label: "wrong case", build: () => makeReq({ "x-stub-user-role": "Admin" }) },
    { label: "unknown role", build: () => makeReq({ "x-stub-user-role": "superuser" }) },
    { label: "comma-joined", build: () => makeReq({ "x-stub-user-role": "admin, user" }) },
  ])("returns 401 and does NOT invoke handler for $label", async ({ build }) => {
    const spy = vi.fn(async () => new Response("ok"));
    const wrapped = withUserOrAdmin(spy);

    const res = await wrapped(build(), {});

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="stub"');
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("has no 403 path by construction (both recognized roles authorized)", async () => {
    // Distinguishes from withAdmin: a hypothetical regression that copied
    // withAdmin's "user → forbidden" branch into withUserOrAdmin would fail
    // because user requests would return 403 instead of 200.
    const spy = vi.fn(async () => new Response("ok", { status: 200 }));
    const wrapped = withUserOrAdmin(spy);

    const userRes = await wrapped(makeReq({ "x-stub-user-role": "user" }), {});

    expect(userRes.status).toBe(200);
    expect(userRes.status).not.toBe(403);
  });
});

describe("resolveRoleFromHeader — single canonical role parser", () => {
  // The page surface (app/entries/[id]/page.tsx) consumes this directly
  // and the route wrappers (withAdmin, withUserOrAdmin) defer to it.
  // A regression that admitted "Admin" or "admin " here would silently
  // weaken iron rule #6 on BOTH surfaces, so we pin the parser's
  // semantics independently of the wrapper tests below.

  it("admits exact 'admin'", () => {
    expect(resolveRoleFromHeader("admin")).toBe("admin");
  });

  it("admits exact 'user'", () => {
    expect(resolveRoleFromHeader("user")).toBe("user");
  });

  it.each([
    { label: "null (header absent)", value: null },
    { label: "empty string", value: "" },
    { label: "wrong case 'Admin'", value: "Admin" },
    { label: "wrong case 'USER'", value: "USER" },
    { label: "unknown role 'superuser'", value: "superuser" },
    { label: "unknown role 'guest'", value: "guest" },
    { label: "comma-joined 'admin, user'", value: "admin, user" },
    { label: "padded 'admin '", value: "admin " },
    { label: "padded ' user'", value: " user" },
    { label: "JSON-ish '\"admin\"'", value: '"admin"' },
  ])("returns null for $label", ({ value }) => {
    expect(resolveRoleFromHeader(value)).toBeNull();
  });

  it("never admits a value outside the Role union (negative-assertion)", () => {
    // If a future regression added `if (raw.startsWith("admin")) return "admin"`,
    // this case would pass when it shouldn't. The literal-comparison contract
    // is what keeps the existence-leak defense in lib/entries.ts watertight.
    const sneaky = ["admin\n", "admin\t", "admin/x", "admin;DROP TABLE", "ADMIN"];
    for (const v of sneaky) {
      expect(resolveRoleFromHeader(v)).toBeNull();
    }
  });
});

describe("sensitivityAllowedForRole — iron-rule #6 mapping is total over Role", () => {
  it("admin → public, internal, restricted", () => {
    expect(sensitivityAllowedForRole("admin")).toEqual(["public", "internal", "restricted"]);
  });

  it("user → public + internal (per ADR-0012 §6 table)", () => {
    expect(sensitivityAllowedForRole("user")).toEqual(["public", "internal"]);
  });

  it("never returns an empty array for a valid Role", () => {
    // Negative-assertion: a regression that returned [] would silently
    // degrade retrieval to "no_content" via keywordCandidates' empty-
    // allow-list short-circuit, instead of failing at the auth layer.
    // Distinguishes from "user can't see restricted" — that's the SQL's
    // job; this test pins the mapping's totality.
    const roles: Role[] = ["admin", "user"];
    for (const role of roles) {
      expect(sensitivityAllowedForRole(role).length).toBeGreaterThan(0);
    }
  });

  it("user mapping omits 'restricted' (negative-assertion)", () => {
    // The three-tier enum's design intent (ADR-0012 §6): `restricted` IS
    // the admin-only escape hatch. A regression that returned
    // ['public','internal','restricted'] for user would expose
    // restricted entries via the keyword and ANN lane SQL WHEREs, breaking
    // iron-rule #6's "restricted is admin-only" semantics. `internal` is
    // org-internal and visible to authenticated end users by design — that
    // is NOT a regression, see lib/auth.ts:175 JSDoc.
    const userAllowed = sensitivityAllowedForRole("user");
    expect(userAllowed).not.toContain("restricted");
  });
});
