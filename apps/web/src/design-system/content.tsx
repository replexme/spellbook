import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`ds-brand ${compact ? "is-compact" : ""}`}>
      <span className="ds-brand-symbol" aria-hidden="true">
        <span>S</span>
      </span>
      {!compact ? <span>Spellbook</span> : null}
    </span>
  );
}

export function SearchField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="ds-input-affix">
      <Icon name="search" size={15} />
      <span className="ds-visually-hidden">{label}</span>
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

/**
 * A verification line. `evidence` names the data that proves it (for
 * reviewers and tests); a line without evidence cannot be rendered as ok.
 */
export type CheckItem = {
  /** `info` states what a file or engine allows; it is not a check. */
  tone: "ok" | "warn" | "fail" | "na" | "info";
  label: ReactNode;
  evidence: string;
};

const checkIcon: Record<CheckItem["tone"], IconName> = {
  ok: "check",
  warn: "warning",
  fail: "close",
  na: "dash",
  info: "info",
};

export function CheckList({
  items,
  label,
}: {
  items: CheckItem[];
  label?: string;
}) {
  if (!items.length) return null;
  return (
    <ul className="ds-checks" aria-label={label}>
      {items.map((item, index) => (
        <li
          key={index}
          className={`is-${item.tone}`}
          data-evidence={item.evidence}
        >
          <Icon name={checkIcon[item.tone]} size={14} />
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

export type StepState = "done" | "now" | "todo" | "failed";

export function StepList({
  steps,
  label,
}: {
  steps: Array<{ label: ReactNode; state: StepState }>;
  label?: string;
}) {
  return (
    <ol className="ds-steps" aria-label={label}>
      {steps.map((step, index) => (
        <li key={index} className={`is-${step.state}`}>
          {step.state === "done" ? (
            <Icon name="check" size={14} />
          ) : step.state === "now" ? (
            <span className="ds-spinner is-ai" aria-hidden="true" />
          ) : step.state === "failed" ? (
            <Icon name="close" size={14} />
          ) : (
            <i className="ds-step-todo" aria-hidden="true" />
          )}
          <span>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** PowerPoint file mark for lists and dialogs. */
export function FileMark({ muted = false }: { muted?: boolean }) {
  return (
    <span
      className={`ds-file-mark ${muted ? "is-muted" : ""}`}
      aria-hidden="true"
    >
      P
    </span>
  );
}
