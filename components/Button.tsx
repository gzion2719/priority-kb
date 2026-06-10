"use client";

// components/Button.tsx — M4.5/B brand button primitive.
//
// Closes UI_AUDIT.md C15. Variant is the only styling vector — `className`
// and `style` are intentionally absent from the prop surface so consumers
// CANNOT bypass the brand `.btn` primitive with inline overrides (which
// was the C7 + C15 failure mode in M4.5/A's renamed sites).
//
// Type contract pinned by ADR-0026 §4. The Pick<> set is the small subset
// of <button> HTML attrs that real consumers in this repo use today:
// form-association (name/value/form/formAction/...), a11y labeling +
// state, and `title` for tooltips. The data-* index signature admits test
// selectors (data-testid etc.) without enumerating each one.
//
// `aria-busy` is added in M4.5/B beyond ADR-0026 §4's listed a11y state
// attrs — it pairs with the new `.btn[aria-busy="true"] { cursor: wait; }`
// rule in styles/kramer-brand.css to preserve the "wait" cursor that the
// pre-migration inline styles set via `cursor: submitting ? "wait" : ...`.
// Documented in the PR body.

import type { ButtonHTMLAttributes, MouseEventHandler, ReactNode, Ref } from "react";

export type ButtonVariant = "primary" | "cta" | "secondary" | "danger";

export type ButtonProps = {
  variant?: ButtonVariant; // default "primary"
  type?: "button" | "submit" | "reset"; // default "button" (defensive)
  disabled?: boolean;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
  ref?: Ref<HTMLButtonElement | null>;
} & Pick<
  ButtonHTMLAttributes<HTMLButtonElement>,
  // Form-association
  | "name"
  | "value"
  | "form"
  | "formAction"
  | "formMethod"
  | "formNoValidate"
  | "formTarget"
  | "formEncType"
  // a11y attrs
  | "autoFocus"
  | "tabIndex"
  | "aria-label"
  | "aria-labelledby"
  | "aria-describedby"
  | "aria-pressed"
  | "aria-expanded"
  | "aria-controls"
  | "aria-busy"
  // Tooltip
  | "title"
> & {
    // data-* attrs (data-testid etc.) — required because ButtonHTMLAttributes'
    // own data-* support is via the broader [key: string] signature which
    // Pick<> cannot reach selectively.
    [key: `data-${string}`]: string | number | undefined;
  };

// variant → className mapping per ADR-0026 §4 table. `.btn` is the brand
// base; the modifier composes via space-separated class. The brand CSS
// selectors (button.cta, .btn.cta, etc.) match either route.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "btn",
  cta: "btn cta",
  secondary: "btn secondary",
  danger: "btn alert",
};

export function Button(props: ButtonProps): React.ReactElement {
  const { variant = "primary", type = "button", disabled, onClick, children, ref, ...rest } = props;
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={VARIANT_CLASS[variant]}
      ref={ref}
      {...rest}
    >
      {children}
    </button>
  );
}
