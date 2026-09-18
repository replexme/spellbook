"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import { Icon } from "./icon";

/** A rectangle in slide-relative units (0–1), drawn over a slide image. */
export type SlideMark = {
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  focused?: boolean;
};

/**
 * A rendered slide (preview or screenshot). Marks outline changed elements;
 * they are drawn on our image, never inside the live editor. A missing or
 * unreadable image shows the empty slide shape instead of a broken image.
 */
export function SlideImage({
  src,
  alt,
  ratio = 16 / 9,
  marks,
  placeholder,
  loading = "lazy",
}: {
  src?: string | null;
  alt: string;
  ratio?: number;
  marks?: SlideMark[];
  placeholder?: ReactNode;
  loading?: "lazy" | "eager";
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 16 / 9;
  if (!src || failedSrc === src)
    return (
      <span
        className="ds-slide is-empty"
        style={{ aspectRatio: safeRatio }}
        role="img"
        aria-label={alt}
      >
        {placeholder ?? <Icon name="slides" size={18} />}
      </span>
    );
  return (
    <span className="ds-slide" style={{ aspectRatio: safeRatio }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- previews are private authenticated assets */}
      <img
        src={src}
        alt={alt}
        loading={loading}
        draggable={false}
        onError={() => setFailedSrc(src)}
      />
      {marks?.map((mark, index) => (
        <span
          key={index}
          className={`ds-slide-mark ${mark.focused ? "is-focused" : ""}`}
          style={{
            left: `${mark.x * 100}%`,
            top: `${mark.y * 100}%`,
            width: `${mark.width * 100}%`,
            height: `${mark.height * 100}%`,
          }}
        >
          {mark.label ? <span>{mark.label}</span> : null}
        </span>
      ))}
    </span>
  );
}
