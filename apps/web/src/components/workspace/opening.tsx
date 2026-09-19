import type { ReactNode } from "react";
import { Icon, SlideImage } from "@/design-system";

/**
 * Fills the canvas until the editor draws the document: the person's own
 * slides (the server's saved previews) where the slide list and canvas will
 * be, then one line of progress.
 */
export function OpeningView({
  preview,
  previews = [],
  message,
  action,
}: {
  preview?: string | null;
  /** Saved previews of the slides, for the slide-list column. */
  previews?: Array<string | null>;
  message: string;
  action?: ReactNode;
}) {
  const first = preview ?? previews[0] ?? null;
  return (
    <div className={`ws-opening ${previews.length > 1 ? "has-strip" : ""}`}>
      {previews.length > 1 ? (
        <ol className="ws-opening-strip" aria-label="슬라이드 목록 미리보기">
          {previews.slice(0, 12).map((src, index) => (
            <li key={index}>
              <span className="ds-tabular">{index + 1}</span>
              <SlideImage src={src} alt={`${index + 1}번 슬라이드 미리보기`} />
            </li>
          ))}
        </ol>
      ) : null}
      {first ? (
        <div className="ws-opening-slide">
          <SlideImage src={first} alt="첫 슬라이드 미리보기" loading="eager" />
        </div>
      ) : (
        <span />
      )}
      <div className="ws-opening-foot">
        <p className="ws-opening-pill" role="status">
          <span className="ds-spinner is-inverse" aria-hidden="true" />
          <span>{message}</span>
        </p>
        {action}
      </div>
    </div>
  );
}

/** Opening failed: what happened, what is safe, and what to do next. */
export function OpeningFailure({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="ws-opening">
      <section
        className="ws-opening-card"
        role="alert"
        aria-labelledby="ws-opening-title"
      >
        <h2 id="ws-opening-title">
          <Icon name="warning" size={18} />
          {title}
        </h2>
        <p>{children}</p>
        <footer>{actions}</footer>
      </section>
    </div>
  );
}
