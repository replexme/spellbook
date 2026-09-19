"use client";

import type { KeyboardEvent, ReactNode } from "react";
import { useRef } from "react";
import { Icon, type IconName } from "./icon";

type Option<T extends string> = {
  value: T;
  label: ReactNode;
  icon?: IconName;
  /** Required when the label is icon-only. */
  ariaLabel?: string;
  disabled?: boolean;
};

function moveFocus(
  event: KeyboardEvent<HTMLElement>,
  container: HTMLElement | null,
  selector: string,
) {
  if (!container) return null;
  const keys = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
  ];
  if (!keys.includes(event.key)) return null;
  const items = [...container.querySelectorAll<HTMLElement>(selector)].filter(
    (item) => !item.hasAttribute("disabled"),
  );
  const current = items.indexOf(document.activeElement as HTMLElement);
  if (current < 0 || !items.length) return null;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? (current - 1 + items.length) % items.length
          : (current + 1) % items.length;
  items[next]?.focus();
  return items[next] ?? null;
}

/** Mutually exclusive choice among 2–4 short options. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const group = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={group}
      className="ds-segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event) => {
        const next = moveFocus(event, group.current, "button");
        const nextValue = next?.dataset.value as T | undefined;
        if (nextValue) onChange(nextValue);
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          data-value={option.value}
          aria-checked={option.value === value}
          aria-label={option.ariaLabel}
          tabIndex={option.value === value ? 0 : -1}
          disabled={disabled || option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.icon ? <Icon name={option.icon} size={15} /> : null}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Tabs switch between sibling panels. Pair with TabPanel ids. */
export function Tabs<T extends string>({
  label,
  value,
  options,
  onChange,
  idPrefix,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  idPrefix: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={list}
      className="ds-tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={(event) => {
        const next = moveFocus(event, list.current, '[role="tab"]');
        const nextValue = next?.dataset.value as T | undefined;
        if (nextValue) onChange(nextValue);
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          className="ds-tab"
          id={`${idPrefix}-tab-${option.value}`}
          aria-controls={`${idPrefix}-panel-${option.value}`}
          aria-selected={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          data-value={option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.icon ? <Icon name={option.icon} size={15} /> : null}
          {option.label}
        </button>
      ))}
    </div>
  );
}
