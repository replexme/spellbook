import type { ReactNode } from "react";
import { Brand, Icon, type IconName } from "@/design-system";
import { supportMailto, type SupportContext } from "@/lib/support";

/** A link that opens an email to support with identifiers filled in. */
export function SupportLink({
  context,
  children = "문의·문제 신고",
}: {
  context?: SupportContext;
  children?: ReactNode;
}) {
  const href = supportMailto(context);
  if (!href) return null;
  return (
    <a className="support-link" href={href}>
      {children}
    </a>
  );
}

/**
 * A whole page that says what happened and what to do: missing pages,
 * failures and download problems. Works without the app's data.
 */
export function StatusScreen({
  icon = "warning",
  title,
  children,
  actions,
  reference,
  support,
}: {
  icon?: IconName;
  title: string;
  children: ReactNode;
  actions: ReactNode;
  /** A number the person can quote when asking for help. */
  reference?: string | null;
  support?: SupportContext;
}) {
  return (
    <main className="status-screen">
      <section className="status-card" aria-labelledby="status-title">
        <Brand />
        <span className="status-mark" aria-hidden="true">
          <Icon name={icon} size={22} />
        </span>
        <h1 id="status-title">{title}</h1>
        <div className="status-body">{children}</div>
        <div className="status-actions">{actions}</div>
        {reference ? (
          <p className="status-reference ds-tabular">오류 번호 {reference}</p>
        ) : null}
        <SupportLink
          context={{ ...support, errorReference: reference ?? undefined }}
        />
      </section>
    </main>
  );
}
