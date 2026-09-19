/*
 * A person-facing name for a slide element ("제목", "텍스트 상자"), from the
 * editor's object name and shape type. Shared by result cards and the
 * request box; no server code.
 */

type Named = { name?: unknown; kind?: unknown };

const namePrefixes: Array<[RegExp, string]> = [
  [/^title\b/i, "제목"],
  [/^subtitle\b/i, "부제목"],
  [/^(text ?box|textshape)\b/i, "텍스트 상자"],
  [/^content placeholder\b/i, "내용 상자"],
  [/^(date|footer|slide number) placeholder\b/i, "바닥글"],
  [/^rectangle\b/i, "사각형"],
  [/^rounded rectangle\b/i, "둥근 사각형"],
  [/^oval\b/i, "타원"],
  [/^picture\b/i, "그림"],
  [/^table\b/i, "표"],
  [/^chart\b/i, "차트"],
  [/^group\b/i, "그룹"],
  [/^(straight )?(connector|line)\b/i, "선"],
  [/^media\b/i, "미디어"],
];

const kindLabels: Array<[RegExp, string]> = [
  [/TitleText/i, "제목"],
  [/Subtitle/i, "부제목"],
  [/Outliner|Text/i, "텍스트 상자"],
  [/Graphic|Picture/i, "그림"],
  [/Table/i, "표"],
  [/Chart|OLE2/i, "차트"],
  [/Group/i, "그룹"],
  [/Line|Connector/i, "선"],
  [/Media/i, "미디어"],
  [/Custom|Rectangle|Ellipse|Polygon/i, "도형"],
];

export function elementLabel(element: Named): string {
  const name = typeof element.name === "string" ? element.name.trim() : "";
  for (const [pattern, label] of namePrefixes)
    if (pattern.test(name)) return label;
  if (name && /[가-힣]/.test(name)) return name;
  const kind = String(element.kind ?? "");
  for (const [pattern, label] of kindLabels)
    if (pattern.test(kind)) return label;
  return name || "요소";
}
