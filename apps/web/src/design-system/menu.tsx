"use client";

import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "./icon";

/**
 * Closes a floating surface on outside pointer, Escape, or focus leaving it.
 * Every popover in the product uses this; no popover may stay open by itself.
 */
export function useDismiss(
  open: boolean,
  refs: Array<RefObject<HTMLElement | null>>,
  onDismiss: (reason: "outside" | "escape") => void,
) {
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      refs.some((ref) => ref.current?.contains(target));
    const onPointer = (event: PointerEvent) => {
      if (!inside(event.target)) onDismiss("outside");
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onDismiss("escape");
      }
    };
    const onFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !inside(event.target))
        onDismiss("outside");
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus, true);
    // An iframe (the editor) swallows pointer events; treat window blur as outside.
    const onBlur = () => onDismiss("outside");
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, refs, onDismiss]);
}

export type MenuPlacement =
  | "above-start"
  | "above-end"
  | "below-start"
  | "below-end";

/**
 * A trigger plus a floating menu. The render prop receives `close` so any
 * choice closes the menu; Escape returns focus to the trigger.
 */
export function Menu({
  trigger,
  title,
  placement = "below-start",
  width,
  children,
  label,
}: {
  trigger: (props: {
    open: boolean;
    toggle: () => void;
    ref: RefObject<HTMLButtonElement | null>;
    menuId: string;
  }) => ReactNode;
  title?: string;
  placement?: MenuPlacement;
  width?: number;
  label: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const refs = useRef([anchor]).current;
  const close = useCallback(() => setOpen(false), []);
  const dismiss = useCallback((reason: "outside" | "escape") => {
    setOpen(false);
    if (reason === "escape") triggerRef.current?.focus();
  }, []);
  useDismiss(open, refs, dismiss);
  useEffect(() => {
    if (!open) return;
    const first = menu.current?.querySelector<HTMLElement>(
      '[aria-checked="true"], [role^="menuitem"]:not(:disabled)',
    );
    first?.focus();
  }, [open]);
  const [vertical, horizontal] = placement.split("-");
  return (
    <div className="ds-menu-anchor" ref={anchor}>
      {trigger({
        open,
        toggle: () => setOpen((value) => !value),
        ref: triggerRef,
        menuId,
      })}
      {open ? (
        <div
          ref={menu}
          id={menuId}
          className={`ds-menu is-${vertical} is-${horizontal}`}
          role="menu"
          aria-label={label}
          style={width ? { width } : undefined}
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
            const items = [
              ...(menu.current?.querySelectorAll<HTMLElement>(
                '[role^="menuitem"]:not(:disabled)',
              ) ?? []),
            ];
            const index = items.indexOf(document.activeElement as HTMLElement);
            if (!items.length) return;
            event.preventDefault();
            const next =
              event.key === "ArrowDown"
                ? (index + 1) % items.length
                : (index - 1 + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          {title ? <p className="ds-menu-title">{title}</p> : null}
          {children(close)}
        </div>
      ) : null}
    </div>
  );
}

/** A choice inside a Menu. `checked` makes it a radio item. */
export function MenuItem({
  icon,
  title,
  description,
  checked,
  danger,
  disabled,
  onSelect,
}: {
  icon?: IconName;
  title: ReactNode;
  description?: ReactNode;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  const radio = checked !== undefined;
  return (
    <button
      type="button"
      role={radio ? "menuitemradio" : "menuitem"}
      aria-checked={radio ? checked : undefined}
      className={`ds-menu-item ${danger ? "is-danger" : ""}`}
      disabled={disabled}
      onClick={onSelect}
    >
      {radio ? (
        <i className="ds-menu-mark" aria-hidden="true" />
      ) : icon ? (
        <Icon name={icon} size={16} />
      ) : (
        <i aria-hidden="true" />
      )}
      <span>
        <strong>{title}</strong>
        {description ? <small>{description}</small> : null}
      </span>
    </button>
  );
}

export function MenuSeparator() {
  return <div className="ds-menu-separator" role="separator" />;
}
