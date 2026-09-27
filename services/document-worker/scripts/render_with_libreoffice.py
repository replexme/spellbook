#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import time

import officehelper
import uno
from com.sun.star.beans import PropertyValue
from powerpoint_text_metrics import FontMetricResolver


POWERPOINT_BASELINE_SHIFT_PERCENT = int(
    os.environ.get("SPELLBOOK_POWERPOINT_BASELINE_SHIFT_PERCENT", "0")
)
DEBUG_UNO = os.environ.get("SPELLBOOK_DEBUG_UNO", "0") == "1"
RENDER_PROGRESS = os.environ.get("SPELLBOOK_RENDER_PROGRESS", "0") == "1"
POWERPOINT_TEXT_BLOCK_SHIFT_PERCENT = float(
    os.environ.get("SPELLBOOK_POWERPOINT_TEXT_BLOCK_SHIFT_PERCENT", "0")
)
POWERPOINT_TEXT_BLOCK_SHIFT_REGULAR_ONLY = (
    os.environ.get("SPELLBOOK_POWERPOINT_TEXT_BLOCK_SHIFT_REGULAR_ONLY", "0") == "1"
)
POWERPOINT_METRIC_BASELINE = (
    os.environ.get("SPELLBOOK_POWERPOINT_METRIC_BASELINE", "0") == "1"
)
FONT_METRIC_RESOLVER = FontMetricResolver()
PROPERTY_READ_STATS = {
    "bulkCalls": 0,
    "bulkProperties": 0,
    "fallbackCalls": 0,
    "fallbackProperties": 0,
}
if POWERPOINT_BASELINE_SHIFT_PERCENT not in range(0, 11):
    raise ValueError("SPELLBOOK_POWERPOINT_BASELINE_SHIFT_PERCENT must be 0 through 10")
if not 0 <= POWERPOINT_TEXT_BLOCK_SHIFT_PERCENT <= 10:
    raise ValueError("SPELLBOOK_POWERPOINT_TEXT_BLOCK_SHIFT_PERCENT must be 0 through 10")


def property_value(name, value):
    item = PropertyValue()
    item.Name = name
    item.Value = value
    return item


def east_asian_character(value):
    codepoint = ord(value)
    return (
        0x1100 <= codepoint <= 0x11FF
        or 0x2E80 <= codepoint <= 0x9FFF
        or 0xA960 <= codepoint <= 0xA97F
        or 0xAC00 <= codepoint <= 0xD7FF
        or 0xF900 <= codepoint <= 0xFAFF
    )


def property_if_available(value, name):
    try:
        properties = value.getPropertySetInfo()
        if properties.hasPropertyByName(name):
            return value.getPropertyValue(name)
    except Exception:
        pass
    return None


def property_values_if_available(value, names):
    requested = tuple(sorted(set(names)))
    try:
        if hasattr(value, "getPropertyValues"):
            values = value.getPropertyValues(requested)
            PROPERTY_READ_STATS["bulkCalls"] += 1
            PROPERTY_READ_STATS["bulkProperties"] += len(requested)
            return dict(zip(requested, values))
    except Exception:
        pass
    PROPERTY_READ_STATS["fallbackCalls"] += 1
    PROPERTY_READ_STATS["fallbackProperties"] += len(requested)
    return {name: property_if_available(value, name) for name in requested}


def debug_record(kind, **values):
    if DEBUG_UNO:
        print(
            json.dumps({"kind": kind, **values}, ensure_ascii=False, default=str),
            flush=True,
        )


def disable_spacing_in_text(text, location):
    changed = 0
    if text is None:
        return 0
    paragraphs = text.createEnumeration()
    paragraph_index = 0
    while paragraphs.hasMoreElements():
        paragraph = paragraphs.nextElement()
        paragraph_text = paragraph.getString()
        has_east_asian_text = any(east_asian_character(value) for value in paragraph_text)
        automatic_script_spacing = None
        if has_east_asian_text or DEBUG_UNO:
            automatic_script_spacing = property_if_available(
                paragraph, "ParaIsCharacterDistance"
            )
        if has_east_asian_text and automatic_script_spacing is not False:
            properties = paragraph.getPropertySetInfo()
            if properties.hasPropertyByName("ParaIsCharacterDistance"):
                paragraph.setPropertyValue("ParaIsCharacterDistance", False)
                changed += 1

        if POWERPOINT_BASELINE_SHIFT_PERCENT:
            portions = paragraph.createEnumeration()
            portion_index = 0
            while portions.hasMoreElements():
                portion = portions.nextElement()
                portion_properties = portion.getPropertySetInfo()
                debug_record(
                    "text-portion",
                    location=location,
                    paragraph=paragraph_index,
                    portion=portion_index,
                    text=portion.getString(),
                    charHeight=property_if_available(portion, "CharHeight"),
                    charHeightAsian=property_if_available(portion, "CharHeightAsian"),
                    charFontName=property_if_available(portion, "CharFontName"),
                    charFontNameAsian=property_if_available(portion, "CharFontNameAsian"),
                    charWeight=property_if_available(portion, "CharWeight"),
                    charWeightAsian=property_if_available(portion, "CharWeightAsian"),
                    charEscapement=property_if_available(portion, "CharEscapement"),
                )
                if not (
                    portion_properties.hasPropertyByName("CharEscapement")
                    and portion_properties.hasPropertyByName(
                        "CharEscapementHeight"
                    )
                    and portion.getPropertyValue("CharEscapement") == 0
                ):
                    portion_index += 1
                    continue
                portion.setPropertyValue("CharEscapementHeight", 100)
                portion.setPropertyValue(
                    "CharEscapement", POWERPOINT_BASELINE_SHIFT_PERCENT
                )
                portion_index += 1
        elif DEBUG_UNO:
            portions = paragraph.createEnumeration()
            portion_index = 0
            while portions.hasMoreElements():
                portion = portions.nextElement()
                debug_record(
                    "text-portion",
                    location=location,
                    paragraph=paragraph_index,
                    portion=portion_index,
                    text=portion.getString(),
                    charHeight=property_if_available(portion, "CharHeight"),
                    charHeightAsian=property_if_available(portion, "CharHeightAsian"),
                    charFontName=property_if_available(portion, "CharFontName"),
                    charFontNameAsian=property_if_available(portion, "CharFontNameAsian"),
                    charWeight=property_if_available(portion, "CharWeight"),
                    charWeightAsian=property_if_available(portion, "CharWeightAsian"),
                    charEscapement=property_if_available(portion, "CharEscapement"),
                )
                portion_index += 1
        if DEBUG_UNO:
            debug_record(
                "paragraph",
                location=location,
                paragraph=paragraph_index,
                text=paragraph_text,
                hasEastAsianText=has_east_asian_text,
                paraIsCharacterDistance=automatic_script_spacing,
                paraAdjust=property_if_available(paragraph, "ParaAdjust"),
            )
        paragraph_index += 1
    return changed


def text_char_height(text):
    heights = []
    if text is None:
        return None
    paragraphs = text.createEnumeration()
    while paragraphs.hasMoreElements():
        paragraph = paragraphs.nextElement()
        if not hasattr(paragraph, "createEnumeration"):
            continue
        portions = paragraph.createEnumeration()
        while portions.hasMoreElements():
            portion = portions.nextElement()
            if not portion.getString().strip():
                continue
            height = property_if_available(portion, "CharHeight")
            if isinstance(height, (int, float)) and height > 0:
                heights.append(float(height))
    return max(heights) if heights else None


def text_has_bold_portion(text):
    if text is None:
        return False
    paragraphs = text.createEnumeration()
    while paragraphs.hasMoreElements():
        paragraph = paragraphs.nextElement()
        if not hasattr(paragraph, "createEnumeration"):
            continue
        portions = paragraph.createEnumeration()
        while portions.hasMoreElements():
            portion = portions.nextElement()
            portion_text = portion.getString()
            if not portion_text.strip():
                continue
            weights = [property_if_available(portion, "CharWeight")]
            if any(east_asian_character(value) for value in portion_text):
                weights.append(property_if_available(portion, "CharWeightAsian"))
            if any(
                isinstance(weight, (int, float)) and weight >= 150
                for weight in weights
            ):
                return True
    return False


def numeric_value(candidate, fallback=None):
    return float(candidate) if isinstance(candidate, (int, float)) else fallback


def italic_value(candidate):
    return "ITALIC" in str(candidate).upper() or "OBLIQUE" in str(candidate).upper()


def add_metric_profile(profiles, properties, character_count, asian):
    if character_count <= 0:
        return None
    family = properties.get("CharFontNameAsian" if asian else "CharFontName")
    height = numeric_value(
        properties.get("CharHeightAsian" if asian else "CharHeight"),
        numeric_value(properties.get("CharHeight")),
    )
    weight = numeric_value(
        properties.get("CharWeightAsian" if asian else "CharWeight"),
        numeric_value(properties.get("CharWeight"), 100),
    )
    italic = italic_value(
        properties.get("CharPostureAsian" if asian else "CharPosture")
    )
    if not isinstance(family, str) or not family.strip() or not height or height <= 0:
        return None
    key = (family.strip(), height, bool(weight and weight >= 150), italic)
    profiles[key] = profiles.get(key, 0) + character_count
    return height


def powerpoint_metric_shift(text, location):
    profiles = {}
    max_height = None
    paragraphs = text.createEnumeration()
    while paragraphs.hasMoreElements():
        paragraph = paragraphs.nextElement()
        if not hasattr(paragraph, "createEnumeration"):
            continue
        portions = paragraph.createEnumeration()
        while portions.hasMoreElements():
            portion = portions.nextElement()
            portion_text = portion.getString()
            east_asian_count = sum(
                1 for value in portion_text if east_asian_character(value)
            )
            other_count = sum(
                1
                for value in portion_text
                if not value.isspace() and not east_asian_character(value)
            )
            property_names = []
            if east_asian_count:
                property_names.extend(
                    (
                        "CharFontNameAsian",
                        "CharHeightAsian",
                        "CharWeightAsian",
                        "CharPostureAsian",
                    )
                )
            if other_count:
                property_names.extend(
                    (
                        "CharFontName",
                        "CharHeight",
                        "CharWeight",
                        "CharPosture",
                    )
                )
            if not property_names:
                continue
            properties = property_values_if_available(
                portion,
                property_names,
            )
            if east_asian_count and (
                numeric_value(properties.get("CharHeightAsian")) is None
                or numeric_value(properties.get("CharWeightAsian")) is None
            ):
                properties.update(
                    property_values_if_available(
                        portion, ("CharHeight", "CharWeight")
                    )
                )
            heights = (
                add_metric_profile(profiles, properties, east_asian_count, True),
                add_metric_profile(profiles, properties, other_count, False),
            )
            for height in heights:
                if height and height > 0:
                    max_height = (
                        height if max_height is None else max(max_height, height)
                    )

    if not profiles:
        return None, max_height

    resolved_profiles = []
    try:
        for profile, count in profiles.items():
            family, height, bold, italic = profile
            resolved = FONT_METRIC_RESOLVER.resolve(family, bold, italic)
            if bold and not resolved.metrics.bold:
                debug_record(
                    "metric-baseline-skipped-synthetic-bold",
                    location=location,
                    family=family,
                    resolvedFamily=resolved.resolved_family,
                    resolvedStyle=resolved.resolved_style,
                )
                return None, max_height
            percent = resolved.metrics.baseline_shift_percent
            if abs(percent) > 10:
                debug_record(
                    "metric-baseline-skipped-outlier",
                    location=location,
                    family=family,
                    percent=percent,
                )
                return None, max_height
            resolved_profiles.append(
                {
                    "family": family,
                    "height": height,
                    "bold": bold,
                    "italic": italic,
                    "count": count,
                    "resolved": resolved,
                    "percent": percent,
                    "shiftPoints": height * percent / 100,
                }
            )
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        debug_record(
            "metric-baseline-resolution-failed",
            location=location,
            error=str(error),
        )
        return None, max_height

    resolved_profiles.sort(key=lambda profile: profile["count"], reverse=True)
    dominant = resolved_profiles[0]
    total_count = sum(profile["count"] for profile in resolved_profiles)
    for profile in resolved_profiles[1:]:
        if (
            profile["count"] / total_count >= 0.2
            and abs(profile["shiftPoints"] - dominant["shiftPoints"]) > 0.5
        ):
            debug_record(
                "metric-baseline-skipped-mixed",
                location=location,
                dominantFamily=dominant["family"],
                secondaryFamily=profile["family"],
            )
            return None, max_height

    resolved = dominant["resolved"]
    debug_record(
        "metric-baseline",
        location=location,
        family=dominant["family"],
        resolvedFamily=resolved.resolved_family,
        resolvedStyle=resolved.resolved_style,
        fontPath=resolved.path,
        unitsPerEm=resolved.metrics.units_per_em,
        ascent=resolved.metrics.ascent,
        descent=resolved.metrics.descent,
        charHeight=dominant["height"],
        percent=dominant["percent"],
        shiftPoints=dominant["shiftPoints"],
    )
    return dominant["shiftPoints"], max_height


def shift_text_block(shape, text, location):
    if not POWERPOINT_METRIC_BASELINE and POWERPOINT_TEXT_BLOCK_SHIFT_PERCENT == 0:
        return False
    if (
        not POWERPOINT_METRIC_BASELINE
        and POWERPOINT_TEXT_BLOCK_SHIFT_REGULAR_ONLY
        and text_has_bold_portion(text)
    ):
        debug_record("text-block-shift-skipped-bold", location=location)
        return False
    if POWERPOINT_METRIC_BASELINE:
        shift_points, height_points = powerpoint_metric_shift(text, location)
    else:
        height_points = text_char_height(text)
        shift_points = (
            height_points * POWERPOINT_TEXT_BLOCK_SHIFT_PERCENT / 100
            if height_points is not None
            else None
        )
    shape_properties = property_values_if_available(
        shape,
        (
            "TextUpperDistance",
            "TextLowerDistance",
            "TextVerticalAdjust",
            "TextAutoGrowHeight",
        ),
    )
    upper = shape_properties.get("TextUpperDistance")
    lower = shape_properties.get("TextLowerDistance")
    vertical_adjust = shape_properties.get("TextVerticalAdjust")
    if height_points is None or shift_points is None or upper is None or lower is None:
        return False
    try:
        upper = int(upper)
        lower = int(lower)
    except (TypeError, ValueError):
        return False

    original_position = shape.getPosition() if hasattr(shape, "getPosition") else None
    original_size = shape.getSize() if hasattr(shape, "getSize") else None
    auto_grow_height = shape_properties.get("TextAutoGrowHeight")
    if auto_grow_height is True:
        shape.setPropertyValue("TextAutoGrowHeight", False)
        if original_position is not None:
            shape.setPosition(original_position)
        if original_size is not None:
            shape.setSize(original_size)

    shift = round(
        shift_points * 2540 / 72
    )
    if shift == 0:
        return False
    anchor = str(vertical_adjust)
    if "BOTTOM" in anchor:
        shape.setPropertyValue("TextLowerDistance", max(0, lower + shift))
    elif "CENTER" in anchor:
        upper_delta = max(-upper, -shift)
        lower_delta = 2 * shift + upper_delta
        shape.setPropertyValue("TextUpperDistance", upper + upper_delta)
        shape.setPropertyValue("TextLowerDistance", max(0, lower + lower_delta))
    else:
        shape.setPropertyValue("TextUpperDistance", max(0, upper - shift))
    if original_position is not None:
        shape.setPosition(original_position)
    if original_size is not None:
        shape.setSize(original_size)
    debug_record(
        "text-block-shift",
        location=location,
        anchor=anchor,
        charHeight=height_points,
        shiftPoints=shift_points,
        shiftHundredthMillimeter=shift,
        disabledAutoGrowHeight=auto_grow_height is True,
    )
    return True


def disable_automatic_cjk_script_spacing(shape, location):
    changed = 0
    shape_type = (
        shape.getShapeType()
        if hasattr(shape, "getShapeType")
        else type(shape).__name__
    )
    if DEBUG_UNO:
        position = property_if_available(shape, "Position")
        size = property_if_available(shape, "Size")
        debug_record(
            "shape",
            location=location,
            shapeType=shape_type,
            positionX=getattr(position, "X", None),
            positionY=getattr(position, "Y", None),
            width=getattr(size, "Width", None),
            height=getattr(size, "Height", None),
            textVerticalAdjust=property_if_available(shape, "TextVerticalAdjust"),
            textAutoGrowHeight=property_if_available(shape, "TextAutoGrowHeight"),
            textAutoGrowWidth=property_if_available(shape, "TextAutoGrowWidth"),
            textUpperDistance=property_if_available(shape, "TextUpperDistance"),
            textLowerDistance=property_if_available(shape, "TextLowerDistance"),
            textLeftDistance=property_if_available(shape, "TextLeftDistance"),
            textRightDistance=property_if_available(shape, "TextRightDistance"),
            fontIndependentLineSpacing=property_if_available(
                shape, "FontIndependentLineSpacing"
            ),
        )
    if hasattr(shape, "getCount") and hasattr(shape, "getByIndex"):
        for index in range(shape.getCount()):
            changed += disable_automatic_cjk_script_spacing(
                shape.getByIndex(index), f"{location}/group-{index}"
            )

    if (
        shape_type == "com.sun.star.drawing.TableShape"
    ):
        table = shape.getPropertyValue("Model")
        rows = table.getRows().getCount()
        columns = table.getColumns().getCount()
        for row in range(rows):
            for column in range(columns):
                changed += disable_spacing_in_text(
                    table.getCellByPosition(column, row),
                    f"{location}/cell-{row}-{column}",
                )

    if hasattr(shape, "getText"):
        text = shape.getText()
        changed += disable_spacing_in_text(text, location)
        shift_text_block(shape, text, location)
    return changed


def render(source_path, output_path, page_range=None):
    source_url = uno.systemPathToFileUrl(os.path.abspath(source_path))
    output_url = uno.systemPathToFileUrl(os.path.abspath(output_path))
    with officehelper.SessionManager() as context:
        service_manager = context.ServiceManager
        desktop = service_manager.createInstanceWithContext(
            "com.sun.star.frame.Desktop", context
        )
        document = desktop.loadComponentFromURL(
            source_url,
            "_blank",
            0,
            (property_value("Hidden", True),),
        )
        if document is None:
            raise RuntimeError(f"LibreOffice could not load {source_path}")
        try:
            if not document.supportsService(
                "com.sun.star.presentation.PresentationDocument"
            ):
                raise RuntimeError("The input is not a presentation document")
            pages = document.getDrawPages()
            selected_pages = None
            if page_range:
                selected_pages = [int(value) - 1 for value in page_range.split(",")]
                if (
                    not selected_pages
                    or len(selected_pages) != len(set(selected_pages))
                    or any(index < 0 or index >= pages.getCount() for index in selected_pages)
                ):
                    raise ValueError("Invalid selected slide indexes")
            changed = 0
            normalization_started = time.perf_counter()
            document.lockControllers()
            try:
                for page_index in (
                    selected_pages if selected_pages is not None else range(pages.getCount())
                ):
                    if DEBUG_UNO or RENDER_PROGRESS:
                        print(
                            f"processing slide {page_index + 1}/{pages.getCount()}",
                            flush=True,
                        )
                    page = pages.getByIndex(page_index)
                    for shape_index in range(page.getCount()):
                        changed += disable_automatic_cjk_script_spacing(
                            page.getByIndex(shape_index),
                            f"slide-{page_index + 1}/shape-{shape_index}",
                        )
            finally:
                document.unlockControllers()
            normalization_ms = round(
                (time.perf_counter() - normalization_started) * 1000, 2
            )
            pdf_started = time.perf_counter()
            export_properties = [
                property_value("FilterName", "impress_pdf_Export"),
                property_value("Overwrite", True),
            ]
            if page_range:
                export_properties.append(
                    property_value(
                        "FilterData",
                        uno.Any(
                            "[]com.sun.star.beans.PropertyValue",
                            (property_value("PageRange", page_range),),
                        ),
                    )
                )
            document.storeToURL(
                output_url,
                tuple(export_properties),
            )
            pdf_ms = round((time.perf_counter() - pdf_started) * 1000, 2)
            print(
                f"disabled automatic CJK script spacing in {changed} paragraphs",
                flush=True,
            )
            print(
                json.dumps(
                    {
                        "kind": "render-timing",
                        "normalizationMs": normalization_ms,
                        "pdfMs": pdf_ms,
                        "propertyReads": PROPERTY_READ_STATS,
                    },
                    sort_keys=True,
                ),
                flush=True,
            )
        finally:
            document.close(True)


def main():
    if len(sys.argv) not in (3, 4):
        print(
            "Usage: render_with_libreoffice.py <source.pptx> <output.pdf> [page-range]",
            file=sys.stderr,
        )
        return 2
    render(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
