"use client";

import type { ReactNode } from "react";
import { useEffect, useId, useRef } from "react";
import { IconButton } from "./controls";

/**
 * Modal dialog built on the native <dialog> element: focus is trapped,
 * Escape closes, the rest of the page is inert. Close always goes through
 * onClose so the owner decides what closing means.
 */
export function Dialog({
  open,
  title,
  onClose,
  size = "md",
  dismissible = true,
  leading,
  footer,
  children,
  labelledBy,
  flush = false,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  /** `full` covers the window, for views that replace the canvas. */
  size?: "md" | "wide" | "full";
  /** False while an irreversible step (upload, restore) is running. */
  dismissible?: boolean;
  leading?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  labelledBy?: string;
  /** Body without padding, for full-bleed content such as the compare view. */
  flush?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const generatedId = useId();
  const titleId = labelledBy ?? generatedId;
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const onCancel = (event: Event) => {
      event.preventDefault();
      if (dismissible) onClose();
    };
    element.addEventListener("cancel", onCancel);
    return () => element.removeEventListener("cancel", onCancel);
  }, [dismissible, onClose]);
  return (
    <dialog
      ref={dialog}
      className={`ds-dialog ${size === "wide" ? "is-wide" : size === "full" ? "is-full" : ""}`}
      aria-labelledby={titleId}
      onClick={(event) => {
        if (dismissible && event.target === dialog.current) onClose();
      }}
    >
      {open ? (
        <>
          <header className="ds-dialog-header">
            {leading}
            <h2 id={titleId}>{title}</h2>
            {dismissible ? (
              <IconButton icon="close" label="닫기" size="sm" onClick={onClose} />
            ) : null}
          </header>
          <div className={`ds-dialog-body ${flush ? "is-flush" : ""}`}>{children}</div>
          {footer ? <footer className="ds-dialog-footer">{footer}</footer> : null}
        </>
      ) : null}
    </dialog>
  );
}
