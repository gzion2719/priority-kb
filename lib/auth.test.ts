import { describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

import { withAdmin } from "@/lib/auth";

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
