import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon";

export type Tone = "neutral" | "ai" | "ok" | "warn" | "danger";

/** Status label. Shown only when a state needs attention. */
export function Badge({
  tone = "neutral",
  dot = false,
  children,
}: {
  tone?: Tone | "inverse";
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={`ds-badge ${tone === "neutral" ? "" : `is-${tone}`} ${dot ? "has-dot" : ""}`}
    >
      {children}
    </span>
  );
}

/** Context or scope chip. Pass onClick to make it a control, href to make it a link. */
export function Chip({
  tone = "neutral",
  icon,
  dot,
  trailingIcon,
  onClick,
  href,
  label,
  disabled,
  expanded,
  children,
}: {
  tone?: "neutral" | "ai" | "warn";
  icon?: IconName;
  dot?: "neutral" | "ok" | "warn" | "danger";
  trailingIcon?: IconName;
  onClick?: () => void;
  href?: string;
  label?: string;
  disabled?: boolean;
  expanded?: boolean;
  children: ReactNode;
}) {
  const className = `ds-chip ${tone === "neutral" ? "" : `is-${tone}`}`;
  const content = (
    <>
      {dot ? (
        <i
          className={`ds-dot ${dot === "neutral" ? "" : `is-${dot}`}`}
          aria-hidden="true"
        />
      ) : null}
      {icon ? <Icon name={icon} size={13} /> : null}
      <span>{children}</span>
      {trailingIcon ? <Icon name={trailingIcon} size={13} /> : null}
    </>
  );
  if (href)
    return (
      <a className={className} href={href} aria-label={label}>
        {content}
      </a>
    );
  if (!onClick) return <span className={className}>{content}</span>;
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : "menu"}
      disabled={disabled}
    >
      {content}
    </button>
  );
}

const bannerIcon: Record<Tone, IconName> = {
  neutral: "info",
  ai: "sparkles",
  ok: "check",
  warn: "warning",
  danger: "warning",
};

/** Inline message: one sentence of reason, one of next step. */
export function Banner({
  tone = "neutral",
  icon,
  role,
  action,
  children,
}: {
  tone?: Tone;
  icon?: IconName | null;
  role?: "status" | "alert";
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`ds-banner ${tone === "neutral" ? "" : `is-${tone}`}`}
      role={role}
    >
      {icon === null ? null : (
        <Icon name={icon ?? bannerIcon[tone]} size={15} />
      )}
      <div>{children}</div>
      {action}
    </div>
  );
}

export function Spinner({
  tone = "neutral",
  label,
}: {
  tone?: "neutral" | "ai" | "inverse";
  label?: string;
}) {
  return (
    <span
      className={`ds-spinner ${tone === "neutral" ? "" : `is-${tone}`}`}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/** Determinate when value is a number (0–1), indeterminate otherwise. */
export function Progress({ value, label }: { value?: number; label: string }) {
  const determinate = typeof value === "number" && Number.isFinite(value);
  const percent = determinate
    ? Math.round(Math.min(1, Math.max(0, value)) * 100)
    : 0;
  return (
    <div
      className={`ds-progress ${determinate ? "" : "is-indeterminate"}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? percent : undefined}
    >
      <span style={determinate ? { width: `${percent}%` } : undefined} />
    </div>
  );
}

export function EmptyState({
  icon = "file",
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="ds-empty">
      <span className="ds-empty-mark" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ds-kbd">{children}</kbd>;
}
