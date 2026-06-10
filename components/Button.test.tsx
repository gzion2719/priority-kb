/*
 * Button.test.tsx — M4.5/B brand button primitive.
 *
 * Pure-renderer tests: Button is a synchronous function returning a
 * React element; we inspect the returned element's props directly without
 * rendering to DOM. This works in vitest's default `environment: "node"`
 * (no jsdom / @testing-library/react dep added).
 *
 * Skipped here (out of scope for these tests):
 *  - ref forwarding behavior (React 19's ref-as-prop semantics; covered
 *    upstream by React's own test suite).
 *  - real disabled-button visual / pointer-events (no DOM).
 *  - real click event firing (no DOM).
 *
 * These pure-renderer tests are sufficient because the load-bearing logic
 * is the variant → className mapping + prop passthrough; the rest is
 * React's responsibility.
 */

import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import { Button } from "./Button";
import type { ButtonProps } from "./Button";

// Cast the React element back to a known shape so prop assertions type-check.
type ButtonElement = ReactElement<{
  type: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: (e: unknown) => void;
  className: string;
  children: unknown;
  ref?: unknown;
  [key: string]: unknown;
}>;

function render(props: ButtonProps): ButtonElement {
  return Button(props) as ButtonElement;
}

describe("Button (M4.5/B) — variant → className mapping", () => {
  it("variant='primary' renders className 'btn'", () => {
    const el = render({ variant: "primary", children: "x" });
    expect(el.props.className).toBe("btn");
  });
  it("variant='cta' renders className 'btn cta'", () => {
    const el = render({ variant: "cta", children: "x" });
    expect(el.props.className).toBe("btn cta");
  });
  it("variant='secondary' renders className 'btn secondary'", () => {
    const el = render({ variant: "secondary", children: "x" });
    expect(el.props.className).toBe("btn secondary");
  });
  it("variant='danger' renders className 'btn alert' (maps to existing .btn.alert)", () => {
    const el = render({ variant: "danger", children: "x" });
    expect(el.props.className).toBe("btn alert");
  });
  it("default variant is 'primary'", () => {
    const el = render({ children: "x" });
    expect(el.props.className).toBe("btn");
  });
});

describe("Button (M4.5/B) — defaults", () => {
  it("default type is 'button' (defensive Safari history)", () => {
    const el = render({ children: "x" });
    expect(el.props.type).toBe("button");
  });
  it("type='submit' is forwarded", () => {
    const el = render({ type: "submit", children: "x" });
    expect(el.props.type).toBe("submit");
  });
  it("type='reset' is forwarded", () => {
    const el = render({ type: "reset", children: "x" });
    expect(el.props.type).toBe("reset");
  });
  it("renders a <button> element (not a generic)", () => {
    const el = render({ children: "x" });
    expect(el.type).toBe("button");
  });
});

describe("Button (M4.5/B) — prop forwarding", () => {
  it("disabled is forwarded", () => {
    const el = render({ disabled: true, children: "x" });
    expect(el.props.disabled).toBe(true);
  });
  it("onClick handler is forwarded by reference", () => {
    const onClick = () => {};
    const el = render({ onClick, children: "x" });
    expect(el.props.onClick).toBe(onClick);
  });
  it("children pass through unchanged", () => {
    const el = render({ children: "Save changes" });
    expect(el.props.children).toBe("Save changes");
  });
});

describe("Button (M4.5/B) — data-* and aria-busy passthrough", () => {
  it("data-testid passes through (test-selector preservation)", () => {
    const el = render({ "data-testid": "admin-edit-submit", children: "x" });
    expect(el.props["data-testid"]).toBe("admin-edit-submit");
  });
  it("arbitrary data-* attr passes through", () => {
    const el = render({ "data-busy-source": "form-state", children: "x" });
    expect(el.props["data-busy-source"]).toBe("form-state");
  });
  it("aria-busy passes through (cursor:wait carrier; pairs with kramer-brand.css)", () => {
    const el = render({ "aria-busy": true, children: "x" });
    expect(el.props["aria-busy"]).toBe(true);
  });
  it("aria-label passes through", () => {
    const el = render({ "aria-label": "Save the entry", children: "x" });
    expect(el.props["aria-label"]).toBe("Save the entry");
  });
});

describe("Button (M4.5/B) — does NOT accept className/style (variant-only)", () => {
  it("the props type omits className (compile-time check via inference)", () => {
    // This is a type-level assertion. If `className` is ever added to
    // ButtonProps, the line below becomes legal TypeScript and the test
    // file fails to compile — which IS the regression signal.
    // @ts-expect-error className is intentionally absent from ButtonProps
    const _illegal: ButtonProps = { children: "x", className: "extra" };
    expect(_illegal).toBeDefined();
  });
  it("the props type omits style (compile-time check via inference)", () => {
    // @ts-expect-error style is intentionally absent from ButtonProps
    const _illegal: ButtonProps = { children: "x", style: { color: "red" } };
    expect(_illegal).toBeDefined();
  });
});
