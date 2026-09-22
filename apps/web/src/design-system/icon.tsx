import type { CSSProperties } from "react";

// One stroke icon set on a 24px grid. Add shapes here, never inline SVG in screens.
const iconPaths = {
  arrowLeft: ["M19 12H5", "M11 6l-6 6 6 6"],
  arrowRight: ["M5 12h14", "M13 6l6 6-6 6"],
  arrowUp: ["M12 19V5", "M6 11l6-6 6 6"],
  back: ["M15 6l-6 6 6 6"],
  check: ["m5 12 4 4L19 6"],
  chevronDown: ["m7 10 5 5 5-5"],
  chevronRight: ["m10 7 5 5-5 5"],
  chevronUp: ["m7 14 5-5 5 5"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  close: ["M6 6l12 12M18 6 6 18"],
  compare: ["M4 5h6.5v14H4z", "M13.5 5H20v14h-6.5z"],
  copy: ["M9 9h11v11H9z", "M5 15H4V4h11v1"],
  dash: ["M7 12h10"],
  download: ["M12 4v11m-4-4 4 4 4-4", "M5 20h14"],
  edit: ["M4 20h4L19 9l-4-4L4 16z", "M13.5 6.5l4 4"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v6H4V6h6"],
  eye: [
    "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z",
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  ],
  file: ["M6 3h8l4 4v14H6z", "M14 3v5h5"],
  grid: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
  home: ["m4 11 8-7 8 7v9h-5v-6H9v6H4z"],
  info: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 11v5.5", "M12 7.8v.1"],
  list: [
    "M9 6h11",
    "M9 12h11",
    "M9 18h11",
    "M4.5 6h.01",
    "M4.5 12h.01",
    "M4.5 18h.01",
  ],
  lock: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
  logout: ["M10 5H5v14h5", "M14 8l5 4-5 4", "M19 12H9"],
  more: [
    "M5 12a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 0 0-2.6 0z",
    "M10.7 12a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 0 0-2.6 0z",
    "M16.4 12a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 0 0-2.6 0z",
  ],
  paperclip: [
    "m20.5 11.5-8.9 8.9a5 5 0 0 1-7.1-7.1l9.6-9.6a3.5 3.5 0 0 1 5 5l-9.6 9.6a2 2 0 1 1-2.8-2.8l8.9-8.9",
  ],
  plus: ["M12 5v14", "M5 12h14"],
  redo: ["M20 7v5h-5", "M20 12a8 8 0 1 0-2 5.3"],
  refresh: ["M20 12a8 8 0 1 1-2.3-5.6", "M20 4v4.5h-4.5"],
  restore: ["M4 12a8 8 0 1 0 2.3-5.6", "M4 4v4.5h4.5"],
  save: ["M5 3h12l2 2v16H5z", "M8 3v6h8V3", "M8 16h8"],
  scope: ["M4 8V4h4", "M16 4h4v4", "M20 16v4h-4", "M8 20H4v-4", "M9 9h6v6H9z"],
  search: [
    "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z",
    "m15.5 15.5 4.5 4.5",
  ],
  settings: [
    "M4 7h10",
    "M18 7h2",
    "M4 17h4",
    "M12 17h8",
    "M16 5v4",
    "M10 15v4",
  ],
  shield: [
    "M12 3 5 6v5c0 4.7 2.8 8.1 7 10 4.2-1.9 7-5.3 7-10V6z",
    "m9 12 2 2 4-5",
  ],
  slides: ["M4 5h16v11H4z", "M9 20h6", "M12 16v4"],
  sparkles: [
    "m12 3 1.2 3.3L16.5 7.5l-3.3 1.2L12 12l-1.2-3.3-3.3-1.2 3.3-1.2z",
    "m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z",
  ],
  stop: ["M8 8h8v8H8z"],
  trash: ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"],
  undo: ["M4 7v5h5", "M4 12a8 8 0 1 1 2 5.3"],
  upload: ["M12 20V9m-4 4 4-4 4 4", "M5 4h14"],
  warning: ["M12 3.5 21.5 20h-19z", "M12 10v4.5", "M12 17.2v.1"],
} as const;

export type IconName = keyof typeof iconPaths;

export const iconNames = Object.keys(iconPaths) as IconName[];

export function Icon({
  name,
  size = 18,
  label,
  style,
}: {
  name: IconName;
  size?: number;
  /** Give a label only when the icon is the sole content of a control. */
  label?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      className="ds-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      {iconPaths[name].map((value, index) => (
        <path key={index} d={value} />
      ))}
    </svg>
  );
}
