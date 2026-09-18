import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ReactNode,
} from "react";
import { forwardRef } from "react";
import { Icon, type IconName } from "./icon";

export type ButtonVariant =
  | "primary"
  | "ai"
  | "ai-soft"
  | "secondary"
  | "quiet"
  | "danger"
  | "danger-quiet";
export type ControlSize = "sm" | "md" | "lg";

function buttonClass(
  variant: ButtonVariant,
  size: ControlSize,
  block: boolean | undefined,
  extra: string | undefined,
) {
  return [
    "ds-button",
    variant === "secondary" ? "" : `is-${variant}`,
    size === "md" ? "" : `is-${size}`,
    block ? "is-block" : "",
    extra ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

type ButtonOwnProps = {
  variant?: ButtonVariant;
  size?: ControlSize;
  icon?: IconName;
  iconEnd?: IconName;
  loading?: boolean;
  block?: boolean;
  children?: ReactNode;
};

/** The one button. Primary is ink; `ai` is reserved for sending work to the AI. */
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonOwnProps & ButtonHTMLAttributes<HTMLButtonElement>
>(function Button(
  {
    variant = "secondary",
    size = "md",
    icon,
    iconEnd,
    loading = false,
    block,
    className,
    children,
    disabled,
    type = "button",
    ...rest
  },
  ref,
) {
  const iconSize = size === "sm" ? 14 : 16;
  return (
    <button
      ref={ref}
      type={type}
      className={buttonClass(variant, size, block, className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <span
          className={`ds-spinner ${variant === "primary" || variant === "ai" || variant === "danger" ? "is-inverse" : ""}`}
          aria-hidden="true"
        />
      ) : icon ? (
        <Icon name={icon} size={iconSize} />
      ) : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} size={iconSize} /> : null}
    </button>
  );
});

/** A link that looks like a button. Use for navigation, never for actions. */
export function ButtonLink({
  variant = "secondary",
  size = "md",
  icon,
  iconEnd,
  block,
  className,
  children,
  ...rest
}: ButtonOwnProps & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const iconSize = size === "sm" ? 14 : 16;
  return (
    <a className={buttonClass(variant, size, block, className)} {...rest}>
      {icon ? <Icon name={icon} size={iconSize} /> : null}
      {children}
      {iconEnd ? <Icon name={iconEnd} size={iconSize} /> : null}
    </a>
  );
}

/** Icon-only control. The accessible name is required. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  {
    icon: IconName;
    label: string;
    size?: "sm" | "md";
    tone?: "default" | "ai" | "primary";
    pressed?: boolean;
  } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">
>(function IconButton(
  {
    icon,
    label,
    size = "md",
    tone = "default",
    pressed,
    className,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={[
        "ds-icon-button",
        size === "sm" ? "is-sm" : "",
        tone === "default" ? "" : `is-${tone}`,
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...rest}
    >
      <Icon name={icon} size={size === "sm" ? 15 : 17} />
    </button>
  );
});
