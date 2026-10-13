#!/usr/bin/env python3
"""Compare text geometry between a PowerPoint PDF and a candidate renderer's PDF.

Both PDFs must come from the same PPTX. For every page the script extracts
character boxes and the font each character was set in, groups characters
into visual lines, aligns lines between the two documents by text, and reports
per-line width deltas together with a breakdown by character class
(Hangul, Latin letters, digits, spaces, punctuation, other).

The report separates two questions that pixel RMSE cannot:
  * did the same characters end up on the same lines (line structure), and
  * where does a line's width drift come from (font slot, advance, spacing).

Usage:
  python3 scripts/compare-pdf-text-geometry.py \
      --reference eval/.../powerpoint.pdf --candidate eval/.../candidate.pdf \
      --output .tmp-eval/results/pdf-text-geometry-<candidate>/ [--pages 49,55]
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
import sys
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, asdict
from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError as error:  # pragma: no cover - environment guard
    sys.exit(f"PyMuPDF is required: {error}")


CONTRACT_VERSION = "1.2"


def character_class(ch: str) -> str:
    code = ord(ch)
    if ch == " " or ch == " ":
        return "space"
    if 0xAC00 <= code <= 0xD7A3 or 0x1100 <= code <= 0x11FF or 0x3130 <= code <= 0x318F:
        return "hangul"
    if 0x4E00 <= code <= 0x9FFF or 0x3040 <= code <= 0x30FF or 0x3400 <= code <= 0x4DBF:
        return "cjk"
    if 0xFF00 <= code <= 0xFFEF or 0x3000 <= code <= 0x303F:
        return "fullwidth"
    if ch.isdigit():
        return "digit"
    if ch.isalpha() and code < 0x0250:
        return "latin"
    category = unicodedata.category(ch)
    if category.startswith("P") or category.startswith("S"):
        return "punct"
    return "other"


@dataclass
class Char:
    text: str
    x0: float
    x1: float
    y0: float
    y1: float
    font: str
    size: float
    cls: str
    origin_x: float | None = None
    origin_y: float | None = None
    origin_advance: float | None = None
    reported_bold: bool | None = None
    reported_italic: bool | None = None

    @property
    def advance(self) -> float | None:
        # A glyph box is not its advance: kerning and tracking change the
        # distance to the next origin without changing the glyph box.
        return self.origin_advance


@dataclass
class Line:
    page: int
    index: int
    text: str
    x0: float
    x1: float
    y_center: float
    chars: list[Char]

    @property
    def width(self) -> float:
        return self.x1 - self.x0


def extract_lines(document: fitz.Document, pages: set[int] | None) -> dict[int, list[Line]]:
    result: dict[int, list[Line]] = {}
    for page_index in range(document.page_count):
        page_number = page_index + 1
        if pages and page_number not in pages:
            continue
        page = document[page_index]
        raw = page.get_text("rawdict", flags=fitz.TEXT_PRESERVE_WHITESPACE)
        lines: list[Line] = []
        for block in raw.get("blocks", []):
            if block.get("type") != 0:
                continue
            for line in block.get("lines", []):
                chars: list[Char] = []
                for span in line.get("spans", []):
                    font = span.get("font", "")
                    size = float(span.get("size", 0.0))
                    for ch in span.get("chars", []):
                        text = ch.get("c", "")
                        if not text:
                            continue
                        bbox = ch.get("bbox", [0, 0, 0, 0])
                        chars.append(
                            Char(
                                text=text,
                                x0=float(bbox[0]),
                                x1=float(bbox[2]),
                                y0=float(bbox[1]),
                                y1=float(bbox[3]),
                                font=font,
                                size=size,
                                cls=character_class(text),
                                origin_x=float(ch["origin"][0]) if "origin" in ch else None,
                                origin_y=float(ch["origin"][1]) if "origin" in ch else None,
                                reported_bold=bool(span["flags"] & fitz.TEXT_FONT_BOLD) if "flags" in span else None,
                                reported_italic=bool(span["flags"] & fitz.TEXT_FONT_ITALIC) if "flags" in span else None,
                            )
                        )
                if not chars:
                    continue
                set_origin_advances(chars, line.get("dir", [1.0, 0.0]))
                visible = [c for c in chars if c.cls != "space"]
                if not visible:
                    continue
                text = "".join(c.text for c in chars)
                lines.append(
                    Line(
                        page=page_number,
                        index=len(lines),
                        text=text,
                        x0=min(c.x0 for c in visible),
                        x1=max(c.x1 for c in visible),
                        y_center=statistics.fmean((c.y0 + c.y1) / 2 for c in visible),
                        chars=chars,
                    )
                )
        lines.sort(key=lambda l: (round(l.y_center, 1), l.x0))
        for index, line in enumerate(lines):
            line.index = index
        result[page_number] = lines
    return result


def normalized(text: str) -> str:
    return "".join(ch for ch in text if not ch.isspace())


def align_lines(reference: list[Line], candidate: list[Line]) -> list[tuple[Line | None, Line | None]]:
    """Greedy alignment on normalized text with position as tie breaker."""
    pairs: list[tuple[Line | None, Line | None]] = []
    used: set[int] = set()
    for ref in reference:
        key = normalized(ref.text)
        best = None
        best_score = 0.0
        for cand in candidate:
            if cand.index in used:
                continue
            ckey = normalized(cand.text)
            if not key or not ckey:
                continue
            if key == ckey:
                score = 1.0
            else:
                shorter, longer = sorted((key, ckey), key=len)
                if shorter and shorter in longer:
                    score = len(shorter) / len(longer)
                else:
                    common = len(set(key) & set(ckey))
                    score = common / max(len(set(key) | set(ckey)), 1) * 0.5
            distance = abs(ref.y_center - cand.y_center)
            score -= min(distance / 400.0, 0.2)
            if score > best_score:
                best_score = score
                best = cand
        if best is not None and best_score >= 0.5:
            used.add(best.index)
            pairs.append((ref, best))
        else:
            pairs.append((ref, None))
    for cand in candidate:
        if cand.index not in used:
            pairs.append((None, cand))
    return pairs


def set_origin_advances(chars: list[Char], direction: list[float]) -> None:
    """Project adjacent PDF origins onto the text direction.

    The terminal glyph has no following origin and is intentionally unmeasured.
    Never substitute its bounding-box width and call it an advance.
    """
    dx, dy = direction
    for current, following in zip(chars, chars[1:]):
        if None in (current.origin_x, current.origin_y, following.origin_x, following.origin_y):
            continue
        current.origin_advance = (
            (following.origin_x - current.origin_x) * dx
            + (following.origin_y - current.origin_y) * dy
        )


def class_advances(line: Line) -> dict[str, float]:
    totals: dict[str, float] = defaultdict(float)
    for ch in line.chars:
        if ch.advance is not None:
            totals[ch.cls] += ch.advance
    return dict(totals)


def class_fonts(line: Line) -> dict[str, Counter]:
    fonts: dict[str, Counter] = defaultdict(Counter)
    for ch in line.chars:
        fonts[ch.cls][ch.font] += 1
    return fonts


def compare_character_styles(reference: Line, candidate: Line) -> dict | None:
    # Do not attribute style changes after a guessed text alignment. PDF flags
    # describe the font, not the complete painted result (e.g. synthetic bold).
    # Exporters may synthesize whitespace, but non-whitespace characters must
    # match exactly and in order. This relaxation is NOT used for advances.
    reference_chars = [c for c in reference.chars if not c.text.isspace()]
    candidate_chars = [c for c in candidate.chars if not c.text.isspace()]
    if [c.text for c in reference_chars] != [c.text for c in candidate_chars]:
        return None
    transitions = Counter()
    bold_losses = italic_losses = size_changes = 0
    for before, after in zip(reference_chars, candidate_chars):
        if before.font != after.font:
            transitions[(before.font, after.font)] += 1
        bold_losses += before.reported_bold is True and after.reported_bold is False
        italic_losses += before.reported_italic is True and after.reported_italic is False
        size_changes += abs(before.size - after.size) > 0.01
    return {
        "reportedBoldLossCharacters": bold_losses,
        "reportedItalicLossCharacters": italic_losses,
        "sizeChangedCharacters": size_changes,
        "fontTransitions": [
            {"referenceFont": before, "candidateFont": after, "characters": count}
            for (before, after), count in transitions.items()
        ],
    }


def compare(reference_path: Path, candidate_path: Path, pages: set[int] | None) -> dict:
    ref_doc = fitz.open(reference_path)
    cand_doc = fitz.open(candidate_path)
    if ref_doc.page_count != cand_doc.page_count:
        print(
            f"warning: page counts differ ({ref_doc.page_count} vs {cand_doc.page_count})",
            file=sys.stderr,
        )
    ref_lines = extract_lines(ref_doc, pages)
    cand_lines = extract_lines(cand_doc, pages)

    rows: list[dict] = []
    page_summaries: list[dict] = []
    class_delta_totals: dict[str, list[float]] = defaultdict(list)
    font_usage = {"reference": defaultdict(Counter), "candidate": defaultdict(Counter)}
    same_text_widths: list[float] = []

    for page_number in sorted(set(ref_lines) | set(cand_lines)):
        pairs = align_lines(ref_lines.get(page_number, []), cand_lines.get(page_number, []))
        matched = 0
        same_text = 0
        for ref, cand in pairs:
            row = {
                "page": page_number,
                "referenceText": ref.text if ref else "",
                "candidateText": cand.text if cand else "",
                "status": "matched" if ref and cand else ("missing_in_candidate" if ref else "extra_in_candidate"),
            }
            if ref and cand:
                matched += 1
                text_equal = normalized(ref.text) == normalized(cand.text)
                same_text += text_equal
                row.update(
                    {
                        "sameText": text_equal,
                        "sameCharacterSequence": ref.text == cand.text,
                        "referenceX0": round(ref.x0, 2),
                        "referenceX1": round(ref.x1, 2),
                        "candidateX0": round(cand.x0, 2),
                        "candidateX1": round(cand.x1, 2),
                        "referenceWidth": round(ref.width, 2),
                        "candidateWidth": round(cand.width, 2),
                        "widthDeltaPt": round(cand.width - ref.width, 2),
                        "yDeltaPt": round(cand.y_center - ref.y_center, 2),
                    }
                )
                if text_equal:
                    same_text_widths.append(cand.width - ref.width)
                    style_changes = compare_character_styles(ref, cand)
                    if style_changes is not None:
                        row.update(style_changes)
                # PDF exporters can synthesize or omit whitespace. Do not
                # attribute a different number of spaces to font metrics.
                if ref.text == cand.text:
                    ref_adv = class_advances(ref)
                    cand_adv = class_advances(cand)
                    for cls in set(ref_adv) | set(cand_adv):
                        delta = cand_adv.get(cls, 0.0) - ref_adv.get(cls, 0.0)
                        row[f"advanceDelta.{cls}"] = round(delta, 2)
                        class_delta_totals[cls].append(delta)
                    for side, line in (("reference", ref), ("candidate", cand)):
                        for cls, fonts in class_fonts(line).items():
                            font_usage[side][cls].update(fonts)
            rows.append(row)
        page_summaries.append(
            {
                "page": page_number,
                "referenceLines": len(ref_lines.get(page_number, [])),
                "candidateLines": len(cand_lines.get(page_number, [])),
                "matchedLines": matched,
                "sameTextLines": same_text,
            }
        )

    def summary(values: list[float]) -> dict:
        if not values:
            return {"count": 0}
        return {
            "count": len(values),
            "meanPt": round(statistics.fmean(values), 3),
            "medianPt": round(statistics.median(values), 3),
            "sumPt": round(sum(values), 3),
            "absMeanPt": round(statistics.fmean(abs(v) for v in values), 3),
        }

    return {
        "contractVersion": CONTRACT_VERSION,
        "advanceMeasurement": "Adjacent character origin distance projected onto PDF line direction; terminal characters are excluded, glyph bounding boxes are not advances.",
        "styleMeasurement": "Exact non-whitespace character sequences only; this relaxation is not used for advance measurement. Reported font flags and face transitions are review signals, not proof of painted weight; synthetic styles and unmatched lines require visual review.",
        "reference": str(reference_path),
        "candidate": str(candidate_path),
        "pages": page_summaries,
        "lineStructure": {
            "referenceLines": sum(p["referenceLines"] for p in page_summaries),
            "candidateLines": sum(p["candidateLines"] for p in page_summaries),
            "matchedLines": sum(p["matchedLines"] for p in page_summaries),
            "sameTextLines": sum(p["sameTextLines"] for p in page_summaries),
        },
        "sameTextLineWidthDelta": summary(same_text_widths),
        "styleChanges": {
            key: sum(row.get(key, 0) for row in rows)
            for key in ("reportedBoldLossCharacters", "reportedItalicLossCharacters", "sizeChangedCharacters")
        },
        "advanceDeltaByClass": {cls: summary(values) for cls, values in sorted(class_delta_totals.items())},
        "fontUsageByClass": {
            side: {cls: dict(counter.most_common(5)) for cls, counter in usage.items()}
            for side, usage in font_usage.items()
        },
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--reference", required=True, type=Path, help="PowerPoint PDF")
    parser.add_argument("--candidate", required=True, type=Path, help="candidate renderer PDF")
    parser.add_argument("--output", required=True, type=Path, help="output directory")
    parser.add_argument("--pages", default="", help="comma separated 1-based page numbers")
    args = parser.parse_args()

    pages = {int(p) for p in args.pages.split(",") if p.strip()} or None
    report = compare(args.reference, args.candidate, pages)
    args.output.mkdir(parents=True, exist_ok=True)
    rows = report.pop("rows")
    (args.output / "geometry.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    columns: list[str] = []
    for row in rows:
        for key in row:
            if key not in columns:
                columns.append(key)
    with (args.output / "lines.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        writer.writerows(rows)
    structure = report["lineStructure"]
    print(
        json.dumps(
            {
                "lineStructure": structure,
                "sameTextLineWidthDelta": report["sameTextLineWidthDelta"],
                "advanceDeltaByClass": report["advanceDeltaByClass"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
