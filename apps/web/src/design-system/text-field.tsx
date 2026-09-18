"use client";

import type { InputHTMLAttributes, ReactNode } from "react";
import { useId } from "react";

/**
 * Labelled text input. The hint is linked with aria-describedby, not put in
 * the label, so the field's accessible name is the label alone.
 */
export function TextField({
  label,
  hint,
  id,
  ...input
}: {
  label: string;
  hint?: ReactNode;
} & InputHTMLAttributes<HTMLInputElement>) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = `${inputId}-hint`;
  return (
    <div className="ds-field">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        className="ds-input"
        aria-describedby={hint ? hintId : undefined}
        {...input}
      />
      {hint ? (
        <small id={hintId} className="ds-field-hint">
          {hint}
        </small>
      ) : null}
    </div>
  );
}
