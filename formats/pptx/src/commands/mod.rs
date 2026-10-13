//! Edit commands shared by the human UI and the AI.
//!
//! Each command edits only the bytes of its target element and verifies that
//! the rest of the part is unchanged before writing it back.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub mod animation;
mod chart;
pub mod smartart;
pub mod comments;
mod create;
mod document;
mod format;
mod media;
mod paragraph;
mod shape;
mod slideprops;
mod slides;
pub mod structure;
mod style;
mod table;
mod xmledit;

use crate::render::{autofit, measure_shape_text, Resources};
use crate::xml::{escape_text, splice, Tree, NS_A, NS_P};
use crate::{paragraph_texts, shape_id, Error, Presentation};

const EMU_PER_PT: f64 = 12_700.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Command {
    /// Replaces the text of a shape, one string per paragraph. A paragraph
    /// whose text is unchanged keeps its exact bytes. A changed paragraph
    /// keeps its paragraph properties and the formatting of its first run;
    /// its other runs, fields and line breaks become that one run; U+000B in
    /// the text becomes a line break (`a:br`) with the same formatting.
    /// Added paragraphs copy the last existing paragraph.
    ReplaceText { slide: usize, shape_id: u32, paragraphs: Vec<String> },
    /// Moves a shape so its top-left corner is at `x`, `y` (slide points).
    Move { slide: usize, shape_id: u32, x: f64, y: f64 },
    /// Sets a shape's width and height in points, keeping its top-left corner.
    Resize { slide: usize, shape_id: u32, width: f64, height: f64 },
    /// Sets a shape's clockwise rotation in degrees.
    Rotate { slide: usize, shape_id: u32, degrees: f64 },
    /// Sets horizontal and/or vertical flips.
    Flip { slide: usize, shape_id: u32, horizontal: Option<bool>, vertical: Option<bool> },
    SetShapeName { slide: usize, shape_id: u32, name: String },
    /// Sets the alternative text read by screen readers (`descr`).
    SetAltText { slide: usize, shape_id: u32, text: String },
    /// Deletes a shape (refused while an animation or connector uses it).
    DeleteElement { slide: usize, shape_id: u32 },
    SetSlideHidden { slide: usize, hidden: bool },
    /// Solid fill colour, `RRGGBB`.
    FillColor { slide: usize, shape_id: u32, color: String },
    /// Solid outline colour, `RRGGBB`.
    LineColor { slide: usize, shape_id: u32, color: String },
    /// Outline width in points.
    LineWidth { slide: usize, shape_id: u32, width: f64 },
    /// Character formats apply to all of the shape's text, or to paragraph
    /// `paragraph` (0-based) only.
    FontSize { slide: usize, shape_id: u32, paragraph: Option<usize>, size: f64 },
    Bold { slide: usize, shape_id: u32, paragraph: Option<usize>, value: bool },
    Italic { slide: usize, shape_id: u32, paragraph: Option<usize>, value: bool },
    Underline { slide: usize, shape_id: u32, paragraph: Option<usize>, value: bool },
    Strikethrough { slide: usize, shape_id: u32, paragraph: Option<usize>, value: bool },
    FontColor { slide: usize, shape_id: u32, paragraph: Option<usize>, color: String },
    /// Sets the Latin and East Asian font of the text.
    FontFamily { slide: usize, shape_id: u32, paragraph: Option<usize>, family: String },
    /// `left`, `center`, `right`, `justify` or `distributed`.
    ParagraphAlignment { slide: usize, shape_id: u32, paragraph: Option<usize>, align: String },
    /// Inserts an empty slide at position `slide` (1 to count + 1) using the
    /// layout named `layout`, or the layout of the slide before it.
    InsertSlide { slide: usize, layout: Option<String> },
    /// Copies a slide (with its notes, charts and diagrams, without comments)
    /// right after it.
    DuplicateSlide { slide: usize },
    /// Deletes a slide and the parts only it used.
    DeleteSlide { slide: usize },
    /// Moves slide `slide` to position `to`.
    MoveSlide { slide: usize, to: usize },
    RenameSlide { slide: usize, name: String },
    /// Stacking order: `front`, `back`, `forward` or `backward`.
    ZOrder { slide: usize, shape_id: u32, action: String },
    /// Order of all top-level shapes (drawing and screen-reader order).
    SetReadingOrder { slide: usize, order: Vec<u32> },
    /// 0 (transparent) to 1 (opaque).
    FillOpacity { slide: usize, shape_id: u32, opacity: f64 },
    LineOpacity { slide: usize, shape_id: u32, opacity: f64 },
    /// Dash (`solid`, `dash`, `dot`, ...) and arrowheads (`none`, `triangle`, ...).
    SetLineStyle { slide: usize, shape_id: u32, dash: Option<String>, head: Option<String>, tail: Option<String> },
    /// `none`, `solid` (with `color`) or `gradient` (with `colors` and `angle`).
    SetShapeFill { slide: usize, shape_id: u32, fill: String, color: Option<String>, colors: Option<Vec<String>>, angle: Option<f64> },
    /// Outer shadow; distances in points, angle in degrees.
    SetShapeShadow { slide: usize, shape_id: u32, enabled: bool, color: Option<String>, opacity: Option<f64>, blur: Option<f64>, distance: Option<f64>, angle: Option<f64> },
    /// Adds an animation to a top-level shape: `class` `entrance` (default),
    /// `emphasis` or `exit`; `effect` such as `fade`, `fly`, `wipe`, `zoom`,
    /// `spin`; `start` `onClick` (default), `withPrevious` or
    /// `afterPrevious`; `duration` and `delay` in seconds; `index` is the
    /// position in the slide's animation order (0-based, default last).
    AddAnimationEffect { slide: usize, shape_id: u32, effect: String, class: Option<String>, start: Option<String>, duration: Option<f64>, delay: Option<f64>, index: Option<usize> },
    /// Changes the animation at `index` to another preset on the same shape,
    /// keeping when it starts.
    ReplaceAnimationEffect { slide: usize, index: usize, effect: String, class: Option<String> },
    RemoveAnimationEffect { slide: usize, index: usize },
    /// Moves the animation at `index` to position `to` in the order.
    MoveAnimationEffect { slide: usize, index: usize, to: usize },
    /// When the animation at `index` starts, and its delay and duration in seconds.
    SetAnimationTiming { slide: usize, index: usize, start: Option<String>, duration: Option<f64>, delay: Option<f64> },
    /// Replaces a chart's data: category names and series (name and one
    /// value or null per category). Also updates its embedded workbook.
    SetChartData { slide: usize, shape_id: u32, categories: Vec<String>, series: Vec<chart::SeriesData> },
    /// `type` `column`, `bar`, `line`, `pie` or `doughnut`; `grouping`
    /// `clustered`, `stacked` or `percentStacked`.
    SetChartType {
        slide: usize,
        shape_id: u32,
        #[serde(rename = "type")]
        kind: String,
        grouping: Option<String>,
    },
    /// Title (`""` removes it), legend (`r`, `b`, `t`, `l`, `tr`, `none`),
    /// value labels, value gridlines and series colours.
    SetChartFormat { slide: usize, shape_id: u32, title: Option<String>, legend: Option<String>, data_labels: Option<bool>, gridlines: Option<bool>, colors: Option<Vec<String>> },
    /// SmartArt node `index` (document order, 0-based) gets `text` (lines
    /// become paragraphs).
    SetSmartartNode { slide: usize, shape_id: u32, index: usize, text: String },
    /// Adds a node under node `parent` (left out: top level) at `position`
    /// among its children (default last).
    AddSmartartNode { slide: usize, shape_id: u32, parent: Option<usize>, position: Option<usize>, text: String },
    /// Deletes a node and the nodes under it.
    DeleteSmartartNode { slide: usize, shape_id: u32, index: usize },
    /// Inserts a video (MP4, M4V, MOV) or sound (M4A, MP3, WAV), base64,
    /// that plays on click; `poster` is an optional PNG/JPEG/GIF shown for it.
    InsertMedia { slide: usize, data: String, poster: Option<String>, x: Option<f64>, y: Option<f64>, width: Option<f64>, height: Option<f64> },
    /// Replaces the video or sound of a media shape (and its poster).
    ReplaceMedia { slide: usize, shape_id: u32, data: String, poster: Option<String> },
    /// Glow, soft edges and reflection. Each left out stays as it is; a glow
    /// `radius`, `softEdge` or reflection `size` of 0 removes that effect.
    /// Glow opacity defaults to 0.6; reflection defaults are PowerPoint's
    /// "Tight Reflection: Touching" (size 0.35, opacity 0.52, blur 0.5 pt).
    SetShapeEffects { slide: usize, shape_id: u32, glow: Option<GlowParams>, soft_edge: Option<f64>, reflection: Option<ReflectionParams> },
    TextShadow { slide: usize, shape_id: u32, paragraph: Option<usize>, enabled: bool, color: Option<String>, opacity: Option<f64>, blur: Option<f64>, distance: Option<f64>, angle: Option<f64> },
    /// Changes letter case of the text: `upper`, `lower`, `title`, `sentence`.
    SetTextCase { slide: usize, shape_id: u32, paragraph: Option<usize>, case: String },
    /// Character spacing in points.
    SetCharacterSpacing { slide: usize, shape_id: u32, paragraph: Option<usize>, spacing: f64 },
    SetTextLanguage { slide: usize, shape_id: u32, paragraph: Option<usize>, language: String },
    /// `superscript`, `subscript` or `normal`; `offset` as a fraction (default 0.3 / -0.25).
    SetScriptPosition { slide: usize, shape_id: u32, paragraph: Option<usize>, position: String, offset: Option<f64> },
    /// Locks such as `noMove`, `noResize`, `noSelect`: true sets, false clears.
    SetObjectLock { slide: usize, shape_id: u32, locks: std::collections::BTreeMap<String, bool> },
    /// Indents and spacing in points; `lineSpacing` as a multiple (1.5) or `lineSpacingPoints`.
    SetParagraphFormat {
        slide: usize,
        shape_id: u32,
        paragraph: Option<usize>,
        indent_left: Option<f64>,
        indent_first: Option<f64>,
        space_before: Option<f64>,
        space_after: Option<f64>,
        line_spacing: Option<f64>,
        line_spacing_points: Option<f64>,
    },
    /// `none`, `bullet` (with `bullet` character) or `number` (with `scheme`, `start`).
    SetParagraphList { slide: usize, shape_id: u32, paragraph: Option<usize>, kind: String, bullet: Option<String>, scheme: Option<String>, start: Option<u32> },
    /// `none`, `shrink` or `resize`.
    TextAutofit { slide: usize, shape_id: u32, mode: String },
    /// Insets [left, top, right, bottom] in points, anchor, wrap, direction.
    /// WordArt text shape: `preset` such as `textArchUp`, `textCurveDown`,
    /// `textWave1` (ECMA-376 names) or `none`; `adjust` by guide name.
    SetFontwork { slide: usize, shape_id: u32, preset: String, adjust: Option<std::collections::BTreeMap<String, f64>> },
    SetTextBox { slide: usize, shape_id: u32, insets: Option<[f64; 4]>, anchor: Option<String>, wrap: Option<bool>, direction: Option<String> },
    /// Fractions (0 to 1) cut from each side of a picture.
    /// `geometry`: `ellipse` crops to the oval inside the picture's box (PowerPoint's "Crop to
    /// Shape"), `rect` back to a rectangle; absent keeps the picture's outline.
    CropImage { slide: usize, shape_id: u32, left: Option<f64>, top: Option<f64>, right: Option<f64>, bottom: Option<f64>, geometry: Option<String> },
    /// Copies a shape above itself, moved by `dx`, `dy` points.
    DuplicateElement { slide: usize, shape_id: u32, dx: Option<f64>, dy: Option<f64> },
    AddTextBox { slide: usize, x: f64, y: f64, width: f64, height: f64, paragraphs: Vec<String>, size: Option<f64> },
    /// A preset shape (`rect`, `ellipse`, `rightArrow`, ...).
    AddShape { slide: usize, preset: String, x: f64, y: f64, width: f64, height: f64, fill: Option<String>, line: Option<String>, paragraphs: Option<Vec<String>> },
    /// `left`, `center`, `right`, `top`, `middle`, `bottom`; `relativeTo` `selection` (default) or `slide`.
    Align { slide: usize, shape_ids: Vec<u32>, to: String, relative_to: Option<String> },
    /// `horizontal` or `vertical`.
    Distribute { slide: usize, shape_ids: Vec<u32>, direction: String },
    /// Replaces characters `start..end` of one paragraph, keeping formatting.
    ReplaceTextRange { slide: usize, shape_id: u32, paragraph: usize, start: usize, end: usize, text: String },
    /// Table cells count rows and columns from 0.
    SetTableCell { slide: usize, shape_id: u32, row: usize, col: usize, paragraphs: Vec<String> },
    /// `fill` (`RRGGBB` or `none`), border colour/width (all four sides), anchor, margins [l, t, r, b].
    SetTableCellFormat {
        slide: usize,
        shape_id: u32,
        row: usize,
        col: usize,
        fill: Option<String>,
        border_color: Option<String>,
        border_width: Option<f64>,
        anchor: Option<String>,
        margins: Option<[f64; 4]>,
    },
    SetTableRowHeight { slide: usize, shape_id: u32, row: usize, height: f64 },
    SetTableColumnWidth { slide: usize, shape_id: u32, col: usize, width: f64 },
    /// Inserts `count` (default 1) rows before row `row` (row count appends).
    InsertTableRows { slide: usize, shape_id: u32, row: usize, count: Option<usize> },
    DeleteTableRows { slide: usize, shape_id: u32, row: usize, count: Option<usize> },
    InsertTableColumns { slide: usize, shape_id: u32, col: usize, count: Option<usize> },
    DeleteTableColumns { slide: usize, shape_id: u32, col: usize, count: Option<usize> },
    MergeTableCells { slide: usize, shape_id: u32, row: usize, col: usize, rows: usize, cols: usize },
    /// Un-merges the block whose first cell is (`row`, `col`).
    SplitTableCell { slide: usize, shape_id: u32, row: usize, col: usize },
    /// A new table; `cells` gives texts by row.
    AddTable { slide: usize, x: f64, y: f64, width: f64, height: f64, rows: usize, cols: usize, cells: Option<Vec<Vec<String>>> },
    /// A picture from base64 PNG/JPEG/GIF `data`; position and size in points are optional.
    InsertImage { slide: usize, data: String, x: Option<f64>, y: Option<f64>, width: Option<f64>, height: Option<f64>, alt_text: Option<String> },
    /// New image for a picture (or picture-filled shape), keeping its frame.
    ReplaceImage { slide: usize, shape_id: u32, data: String },
    /// Solid background `RRGGBB`, or no `color` to use the layout's.
    SetBackground { slide: usize, color: Option<String> },
    /// `none`, `fade`, `push`, `wipe`, `split`, `cover`, `cut`, `dissolve`, `zoom`.
    SetSlideTransition { slide: usize, transition: String, speed: Option<String>, direction: Option<String> },
    /// Slide size in points (content is not scaled). `slide` is ignored.
    SetSlideSize { slide: usize, width: f64, height: f64 },
    /// Every section with its slides (1-based, in order). `slide` is ignored.
    SetSections { slide: usize, sections: Vec<Section> },
    /// Switches to the layout with this name.
    SetSlideLayout { slide: usize, layout: String },
    SetSpeakerNotes { slide: usize, paragraphs: Vec<String> },
    /// Document properties. `slide` is ignored.
    SetSlideMetadata { slide: usize, title: Option<String>, subject: Option<String>, author: Option<String>, keywords: Option<String>, description: Option<String> },
    /// Theme colours by slot and heading/body fonts (Latin and East Asian). `slide` is ignored.
    SetMasterTheme {
        slide: usize,
        colors: Option<std::collections::BTreeMap<String, String>>,
        heading_font: Option<String>,
        body_font: Option<String>,
        heading_east_asian_font: Option<String>,
        body_east_asian_font: Option<String>,
    },
    /// Click action: `none`, `url`, `slide` (with `targetSlide`), `next`, `previous`, `first`, `last`.
    SetObjectInteraction { slide: usize, shape_id: u32, action: String, url: Option<String>, target_slide: Option<usize> },
    /// Groups top-level shapes.
    Group { slide: usize, shape_ids: Vec<u32> },
    Ungroup { slide: usize, shape_id: u32 },
    /// A connector between shapes (glued at connection sites) or points.
    AddConnector { slide: usize, preset: Option<String>, start: structure::End, end: structure::End, color: Option<String>, width: Option<f64>, arrow: Option<String> },
    /// Re-attaches a connector's ends or changes its kind.
    SetConnector { slide: usize, shape_id: u32, start: Option<structure::End>, end: Option<structure::End>, preset: Option<String> },
    /// A freeform through `points` ([x, y] in slide points), optionally closed.
    AddFreeform { slide: usize, points: Vec<[f64; 2]>, closed: Option<bool>, fill: Option<String>, line: Option<String> },
    /// A comment at (`x`, `y`) slide points; `created` is an ISO 8601 time
    /// (required in the browser, which has no clock here).
    AddComment { slide: usize, text: String, author: Option<String>, x: Option<f64>, y: Option<f64>, created: Option<String> },
    EditComment { slide: usize, comment_id: String, text: String },
    DeleteComment { slide: usize, comment_id: String },
}

/// The current UTC time as ISO 8601, where a clock is available.
fn now_iso() -> Result<String, Error> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| Error::InvalidCommand(e.to_string()))?.as_secs() as i64;
        let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
        // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z - era * 146_097;
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = yoe + era * 400 + i64::from(m <= 2);
        Ok(format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000", rem / 3600, rem % 3600 / 60, rem % 60))
    }
    #[cfg(target_arch = "wasm32")]
    {
        Err(Error::InvalidCommand("add_comment needs `created` (ISO 8601 time)".into()))
    }
}

/// Glow of `set_shape_effects`: radius in points (0 removes), `RRGGBB`
/// colour and opacity 0 to 1.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GlowParams {
    pub radius: f64,
    pub color: Option<String>,
    pub opacity: Option<f64>,
}

/// Reflection of `set_shape_effects`: reflected fraction of the shape's
/// height (0 removes), starting opacity, and distance and blur in points.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReflectionParams {
    pub size: Option<f64>,
    pub opacity: Option<f64>,
    pub distance: Option<f64>,
    pub blur: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Section {
    pub name: String,
    pub slides: Vec<usize>,
}

impl Command {
    /// The slide the command edits (1-based).
    pub fn slide(&self) -> usize {
        self.field("slide").map(|v| v as usize).unwrap_or(0)
    }

    /// The shape the command edits, if it targets one.
    pub fn shape_id(&self) -> Option<u32> {
        self.field("shapeId").map(|v| v as u32)
    }

    fn field(&self, name: &str) -> Option<u64> {
        serde_json::to_value(self).ok()?.get(name)?.as_u64()
    }
}

/// Runs a command without text measurement: autofit values are left as
/// stored and reported as warnings.
pub fn run(doc: &mut Presentation, command: &Command) -> Result<Value, Error> {
    run_with(doc, command, None)
}

/// Runs a command; with `resources` (fonts), text edits also recompute
/// autofit the way PowerPoint does while editing.
pub fn run_with(doc: &mut Presentation, command: &Command, resources: Option<&Resources>) -> Result<Value, Error> {
    use format::CharFormat;
    // Text whose size changes gets its autofit recomputed.
    let text = |doc: &mut Presentation, slide: usize, id: u32, mut result: Value| -> Result<Value, Error> {
        if let (Some(res), true) = (resources, result["changed"] == Value::Bool(true)) {
            result["autofit"] = refit(doc, slide, id, res)?;
            if result.get("warnings").is_some() {
                result["warnings"] = json!(Vec::<String>::new());
            }
        }
        Ok(result)
    };
    let chars = |doc: &mut Presentation, slide: usize, id: u32, p: Option<usize>, f: CharFormat| {
        let r = format::char_format(doc, slide, id, p, &f)?;
        text(doc, slide, id, r)
    };
    match command {
        Command::ReplaceText { slide, shape_id, paragraphs } => {
            let r = replace_text(doc, *slide, *shape_id, paragraphs)?;
            text(doc, *slide, *shape_id, r)
        }
        Command::Move { slide, shape_id, x, y } => shape::move_to(doc, *slide, *shape_id, *x, *y),
        Command::Resize { slide, shape_id, width, height } => {
            let r = shape::resize(doc, *slide, *shape_id, *width, *height)?;
            text(doc, *slide, *shape_id, r)
        }
        Command::Rotate { slide, shape_id, degrees } => shape::rotate(doc, *slide, *shape_id, *degrees),
        Command::Flip { slide, shape_id, horizontal, vertical } => shape::flip(doc, *slide, *shape_id, *horizontal, *vertical),
        Command::SetShapeName { slide, shape_id, name } => shape::set_non_visual(doc, *slide, *shape_id, "set_shape_name", "name", name),
        Command::SetAltText { slide, shape_id, text } => shape::set_non_visual(doc, *slide, *shape_id, "set_alt_text", "descr", text),
        Command::DeleteElement { slide, shape_id } => shape::delete_element(doc, *slide, *shape_id),
        Command::SetSlideHidden { slide, hidden } => shape::set_slide_hidden(doc, *slide, *hidden),
        Command::FillColor { slide, shape_id, color } => shape::fill_color(doc, *slide, *shape_id, color),
        Command::LineColor { slide, shape_id, color } => shape::line_color(doc, *slide, *shape_id, color),
        Command::LineWidth { slide, shape_id, width } => shape::line_width(doc, *slide, *shape_id, *width),
        Command::FontSize { slide, shape_id, paragraph, size } => chars(doc, *slide, *shape_id, *paragraph, CharFormat::Size(*size)),
        Command::Bold { slide, shape_id, paragraph, value } => chars(doc, *slide, *shape_id, *paragraph, CharFormat::Bold(*value)),
        Command::Italic { slide, shape_id, paragraph, value } => chars(doc, *slide, *shape_id, *paragraph, CharFormat::Italic(*value)),
        Command::Underline { slide, shape_id, paragraph, value } => chars(doc, *slide, *shape_id, *paragraph, CharFormat::Underline(*value)),
        Command::Strikethrough { slide, shape_id, paragraph, value } => chars(doc, *slide, *shape_id, *paragraph, CharFormat::Strikethrough(*value)),
        Command::FontColor { slide, shape_id, paragraph, color } => chars(doc, *slide, *shape_id, *paragraph, CharFormat::Color(color.clone())),
        Command::FontFamily { slide, shape_id, paragraph, family } => chars(doc, *slide, *shape_id, *paragraph, CharFormat::Family(family.clone())),
        Command::ParagraphAlignment { slide, shape_id, paragraph, align } => format::paragraph_alignment(doc, *slide, *shape_id, *paragraph, align),
        Command::InsertSlide { slide, layout } => slides::insert_slide(doc, Some(*slide), layout.as_deref()),
        Command::DuplicateSlide { slide } => slides::duplicate_slide(doc, *slide),
        Command::DeleteSlide { slide } => slides::delete_slide(doc, *slide),
        Command::MoveSlide { slide, to } => slides::move_slide(doc, *slide, *to),
        Command::RenameSlide { slide, name } => slides::rename_slide(doc, *slide, name),
        Command::ZOrder { slide, shape_id, action } => style::arrange(doc, *slide, Some(*shape_id), Some(action), None),
        Command::SetReadingOrder { slide, order } => style::arrange(doc, *slide, None, None, Some(order)),
        Command::FillOpacity { slide, shape_id, opacity } => style::fill_opacity(doc, *slide, *shape_id, *opacity),
        Command::LineOpacity { slide, shape_id, opacity } => style::line_opacity(doc, *slide, *shape_id, *opacity),
        Command::SetLineStyle { slide, shape_id, dash, head, tail } => style::set_line_style(doc, *slide, *shape_id, dash.as_deref(), head.as_deref(), tail.as_deref()),
        Command::SetShapeFill { slide, shape_id, fill, color, colors, angle } => style::set_shape_fill(doc, *slide, *shape_id, fill, color.as_deref(), colors.as_deref().unwrap_or(&[]), *angle),
        Command::SetShapeShadow { slide, shape_id, enabled, color, opacity, blur, distance, angle } => {
            let shadow = enabled.then(|| style::Shadow::from_parts(color.as_deref(), *opacity, *blur, *distance, *angle)).transpose()?;
            style::set_shape_shadow(doc, *slide, *shape_id, shadow)
        }
        Command::AddAnimationEffect { slide, shape_id, effect, class, start, duration, delay, index } => {
            let start = start.as_deref().map(animation::Start::parse).transpose()?.unwrap_or(animation::Start::OnClick);
            animation::add_animation_effect(doc, *slide, *shape_id, class.as_deref().unwrap_or("entrance"), effect, start, *duration, *delay, *index)
        }
        Command::ReplaceAnimationEffect { slide, index, effect, class } => animation::replace_animation_effect(doc, *slide, *index, class.as_deref().unwrap_or("entrance"), effect),
        Command::RemoveAnimationEffect { slide, index } => animation::remove_animation_effect(doc, *slide, *index),
        Command::MoveAnimationEffect { slide, index, to } => animation::move_animation_effect(doc, *slide, *index, *to),
        Command::SetAnimationTiming { slide, index, start, duration, delay } => {
            let start = start.as_deref().map(animation::Start::parse).transpose()?;
            animation::set_animation_timing(doc, *slide, *index, start, *duration, *delay)
        }
        Command::InsertMedia { slide, data, poster, x, y, width, height } => media::insert_media(doc, *slide, data, poster.as_deref(), *x, *y, *width, *height),
        Command::ReplaceMedia { slide, shape_id, data, poster } => media::replace_media(doc, *slide, *shape_id, data, poster.as_deref()),
        Command::SetSmartartNode { slide, shape_id, index, text } => smartart::set_smartart_node(doc, *slide, *shape_id, *index, text),
        Command::AddSmartartNode { slide, shape_id, parent, position, text } => smartart::add_smartart_node(doc, *slide, *shape_id, *parent, *position, text),
        Command::DeleteSmartartNode { slide, shape_id, index } => smartart::delete_smartart_node(doc, *slide, *shape_id, *index),
        Command::SetChartData { slide, shape_id, categories, series } => chart::set_chart_data(doc, *slide, *shape_id, categories, series),
        Command::SetChartType { slide, shape_id, kind, grouping } => chart::set_chart_type(doc, *slide, *shape_id, kind, grouping.as_deref()),
        Command::SetChartFormat { slide, shape_id, title, legend, data_labels, gridlines, colors } => chart::set_chart_format(doc, *slide, *shape_id, title.as_deref(), legend.as_deref(), *data_labels, *gridlines, colors.as_deref()),
        Command::SetShapeEffects { slide, shape_id, glow, soft_edge, reflection } => {
            let glow = glow.as_ref().map(|g| if g.radius == 0.0 { Ok(None) } else { style::Glow::from_parts(g.radius, g.color.as_deref().ok_or_else(|| Error::InvalidCommand("glow needs color".into()))?, g.opacity).map(Some) }).transpose()?;
            let soft_edge = soft_edge.map(|r| (r != 0.0).then_some(r));
            let reflection = reflection.as_ref().map(|r| if r.size == Some(0.0) { Ok(None) } else { style::Reflection::from_parts(r.size, r.opacity, r.distance, r.blur).map(Some) }).transpose()?;
            style::set_shape_effects(doc, *slide, *shape_id, glow, soft_edge, reflection)
        }
        Command::TextShadow { slide, shape_id, paragraph, enabled, color, opacity, blur, distance, angle } => {
            let shadow = enabled.then(|| style::Shadow::from_parts(color.as_deref(), *opacity, *blur, *distance, *angle)).transpose()?;
            chars(doc, *slide, *shape_id, *paragraph, CharFormat::Shadow(shadow))
        }
        Command::SetTextCase { slide, shape_id, paragraph, case } => {
            let r = paragraph::set_text_case(doc, *slide, *shape_id, *paragraph, case)?;
            text(doc, *slide, *shape_id, r)
        }
        Command::SetCharacterSpacing { slide, shape_id, paragraph, spacing } => chars(doc, *slide, *shape_id, *paragraph, CharFormat::Spacing(*spacing)),
        Command::SetTextLanguage { slide, shape_id, paragraph, language } => chars(doc, *slide, *shape_id, *paragraph, CharFormat::Language(language.clone())),
        Command::SetScriptPosition { slide, shape_id, paragraph, position, offset } => {
            let v = match position.as_str() {
                "superscript" => offset.unwrap_or(0.3),
                "subscript" => -offset.unwrap_or(0.25).abs(),
                "normal" => 0.0,
                other => return Err(Error::InvalidCommand(format!("position must be superscript, subscript or normal, got {other:?}"))),
            };
            chars(doc, *slide, *shape_id, *paragraph, CharFormat::Script(v))
        }
        Command::SetObjectLock { slide, shape_id, locks } => style::set_object_lock(doc, *slide, *shape_id, locks),
        Command::SetParagraphFormat { slide, shape_id, paragraph, indent_left, indent_first, space_before, space_after, line_spacing, line_spacing_points } => {
            let r = paragraph::set_paragraph_format(doc, *slide, *shape_id, *paragraph, *indent_left, *indent_first, *space_before, *space_after, *line_spacing, *line_spacing_points)?;
            text(doc, *slide, *shape_id, r)
        }
        Command::SetParagraphList { slide, shape_id, paragraph, kind, bullet, scheme, start } => {
            let r = paragraph::set_paragraph_list(doc, *slide, *shape_id, *paragraph, kind, bullet.as_deref(), scheme.as_deref(), *start)?;
            text(doc, *slide, *shape_id, r)
        }
        Command::TextAutofit { slide, shape_id, mode } => {
            let r = paragraph::text_autofit(doc, *slide, *shape_id, mode)?;
            text(doc, *slide, *shape_id, r)
        }
        Command::SetFontwork { slide, shape_id, preset, adjust } => paragraph::set_fontwork(doc, *slide, *shape_id, preset, &adjust.clone().unwrap_or_default()),
        Command::SetTextBox { slide, shape_id, insets, anchor, wrap, direction } => {
            let r = paragraph::set_text_box(doc, *slide, *shape_id, *insets, anchor.as_deref(), *wrap, direction.as_deref())?;
            text(doc, *slide, *shape_id, r)
        }
        Command::CropImage { slide, shape_id, left, top, right, bottom, geometry } => {
            // No fraction at all: only the outline changes and the framing is kept.
            let fractions = [left, top, right, bottom];
            let crop = fractions.iter().any(|f| f.is_some()).then(|| fractions.map(|f| f.unwrap_or(0.0)));
            style::crop_image(doc, *slide, *shape_id, crop, geometry.as_deref())
        }
        Command::DuplicateElement { slide, shape_id, dx, dy } => create::duplicate_element(doc, *slide, *shape_id, dx.unwrap_or(0.0), dy.unwrap_or(0.0)),
        Command::AddTextBox { slide, x, y, width, height, paragraphs, size } => {
            let r = create::add_text_box(doc, *slide, *x, *y, *width, *height, paragraphs, *size)?;
            let id = r["shapeId"].as_u64().unwrap_or(0) as u32;
            text(doc, *slide, id, r)
        }
        Command::AddShape { slide, preset, x, y, width, height, fill, line, paragraphs } => {
            create::add_shape(doc, *slide, preset, *x, *y, *width, *height, fill.as_deref(), line.as_deref(), paragraphs.as_deref().unwrap_or(&[]))
        }
        Command::Align { slide, shape_ids, to, relative_to } => {
            let to_slide = match relative_to.as_deref() {
                None | Some("selection") => false,
                Some("slide") => true,
                Some(other) => return Err(Error::InvalidCommand(format!("relativeTo must be selection or slide, got {other:?}"))),
            };
            create::align(doc, *slide, shape_ids, to, to_slide)
        }
        Command::Distribute { slide, shape_ids, direction } => create::distribute(doc, *slide, shape_ids, direction),
        Command::ReplaceTextRange { slide, shape_id, paragraph, start, end, text: new_text } => {
            let r = paragraph::replace_text_range(doc, *slide, *shape_id, *paragraph, *start, *end, new_text)?;
            text(doc, *slide, *shape_id, r)
        }
        Command::SetTableCell { slide, shape_id, row, col, paragraphs } => table::set_table_cell(doc, *slide, *shape_id, *row, *col, paragraphs),
        Command::SetTableCellFormat { slide, shape_id, row, col, fill, border_color, border_width, anchor, margins } => {
            table::set_table_cell_format(doc, *slide, *shape_id, *row, *col, fill.as_deref(), border_color.as_deref(), *border_width, anchor.as_deref(), *margins)
        }
        Command::SetTableRowHeight { slide, shape_id, row, height } => table::set_table_row_height(doc, *slide, *shape_id, *row, *height),
        Command::SetTableColumnWidth { slide, shape_id, col, width } => table::set_table_column_width(doc, *slide, *shape_id, *col, *width),
        Command::InsertTableRows { slide, shape_id, row, count } => table::insert_table_rows(doc, *slide, *shape_id, *row, count.unwrap_or(1)),
        Command::DeleteTableRows { slide, shape_id, row, count } => table::delete_table_rows(doc, *slide, *shape_id, *row, count.unwrap_or(1)),
        Command::InsertTableColumns { slide, shape_id, col, count } => table::insert_table_columns(doc, *slide, *shape_id, *col, count.unwrap_or(1)),
        Command::DeleteTableColumns { slide, shape_id, col, count } => table::delete_table_columns(doc, *slide, *shape_id, *col, count.unwrap_or(1)),
        Command::MergeTableCells { slide, shape_id, row, col, rows, cols } => table::merge_table_cells(doc, *slide, *shape_id, *row, *col, *rows, *cols),
        Command::SplitTableCell { slide, shape_id, row, col } => table::split_table_cell(doc, *slide, *shape_id, *row, *col),
        Command::AddTable { slide, x, y, width, height, rows, cols, cells } => table::add_table(doc, *slide, *x, *y, *width, *height, *rows, *cols, cells.as_deref().unwrap_or(&[])),
        Command::InsertImage { slide, data, x, y, width, height, alt_text } => media::insert_image(doc, *slide, data, *x, *y, *width, *height, alt_text.as_deref()),
        Command::ReplaceImage { slide, shape_id, data } => media::replace_image(doc, *slide, *shape_id, data),
        Command::SetBackground { slide, color } => slideprops::set_background(doc, *slide, color.as_deref()),
        Command::SetSlideTransition { slide, transition, speed, direction } => slideprops::set_slide_transition(doc, *slide, transition, speed.as_deref(), direction.as_deref()),
        Command::SetSlideSize { width, height, .. } => slideprops::set_slide_size(doc, *width, *height),
        Command::SetSections { sections, .. } => {
            let list: Vec<(String, Vec<usize>)> = sections.iter().map(|s| (s.name.clone(), s.slides.clone())).collect();
            slideprops::set_sections(doc, &list)
        }
        Command::SetSlideLayout { slide, layout } => slideprops::set_slide_layout(doc, *slide, layout),
        Command::SetSpeakerNotes { slide, paragraphs } => slideprops::set_speaker_notes(doc, *slide, paragraphs),
        Command::SetSlideMetadata { title, subject, author, keywords, description, .. } => document::set_document_properties(
            doc,
            &[("title", title.as_deref()), ("subject", subject.as_deref()), ("creator", author.as_deref()), ("keywords", keywords.as_deref()), ("description", description.as_deref())],
        ),
        Command::SetMasterTheme { colors, heading_font, body_font, heading_east_asian_font, body_east_asian_font, .. } => document::set_master_theme(
            doc,
            &colors.clone().unwrap_or_default(),
            &[
                ("majorFont", "latin", heading_font.as_deref()),
                ("minorFont", "latin", body_font.as_deref()),
                ("majorFont", "ea", heading_east_asian_font.as_deref()),
                ("minorFont", "ea", body_east_asian_font.as_deref()),
            ],
        ),
        Command::SetObjectInteraction { slide, shape_id, action, url, target_slide } => document::set_object_interaction(doc, *slide, *shape_id, action, url.as_deref(), *target_slide),
        Command::Group { slide, shape_ids } => structure::group(doc, *slide, shape_ids),
        Command::Ungroup { slide, shape_id } => structure::ungroup(doc, *slide, *shape_id),
        Command::AddConnector { slide, preset, start, end, color, width, arrow } => {
            structure::add_connector(doc, *slide, preset.as_deref().unwrap_or("straightConnector1"), start, end, color.as_deref(), *width, arrow.as_deref())
        }
        Command::SetConnector { slide, shape_id, start, end, preset } => structure::set_connector(doc, *slide, *shape_id, start.as_ref(), end.as_ref(), preset.as_deref()),
        Command::AddFreeform { slide, points, closed, fill, line } => structure::add_freeform(doc, *slide, points, closed.unwrap_or(false), fill.as_deref(), line.as_deref()),
        Command::AddComment { slide, text, author, x, y, created } => {
            let when = match created {
                Some(c) if c.len() >= 10 && c.chars().all(|ch| ch.is_ascii_digit() || "-:.TZ+".contains(ch)) => c.clone(),
                Some(c) => return Err(Error::InvalidCommand(format!("created must be an ISO 8601 time, got {c:?}"))),
                None => now_iso()?,
            };
            comments::add_comment(doc, *slide, text, author.as_deref().unwrap_or("Replex"), x.unwrap_or(10.0), y.unwrap_or(10.0), &when)
        }
        Command::EditComment { slide, comment_id, text } => comments::edit_comment(doc, *slide, comment_id, text),
        Command::DeleteComment { slide, comment_id } => comments::delete_comment(doc, *slide, comment_id),
    }
}

/// Writes PowerPoint's autofit result for the shape's new text: the shrink
/// attributes of `a:normAutofit`, or the height of a `a:spAutoFit` shape.
fn refit(doc: &mut Presentation, slide: usize, id: u32, res: &Resources) -> Result<Value, Error> {
    let part = doc.slide_part(slide)?.to_owned();
    let src = doc.package().read(&part)?;
    let tree = Tree::parse(&src)?;
    let sp_tree = tree.path(tree.root, &[(NS_P, "cSld"), (NS_P, "spTree")]).ok_or_else(|| Error::NotFound("shape tree".into()))?;
    let shape = find_shape(&tree, sp_tree, id).ok_or_else(|| Error::NotFound(format!("shape {id}")))?;
    let Some(body_pr) = tree.path(shape, &[(NS_P, "txBody"), (NS_A, "bodyPr")]) else { return Ok(Value::Null) };
    let Some(m) = measure_shape_text(doc, slide, id, res)? else { return Ok(Value::Null) };
    let mut edits = Vec::new();
    let result;
    if let Some(fit) = tree.child(body_pr, NS_A, "normAutofit") {
        let (scale, reduction) = autofit::shrink(&m, &res.fonts);
        let n = tree.node(fit);
        let mut attrs = String::new();
        if scale < 1.0 {
            attrs.push_str(&format!(r#" fontScale="{}""#, (scale * 100_000.0).round() as i64));
        }
        if reduction > 0.0 {
            attrs.push_str(&format!(r#" lnSpcReduction="{}""#, (reduction * 100_000.0).round() as i64));
        }
        edits.push((n.start..n.end, format!("<{}{attrs}/>", n.qname).into_bytes()));
        result = json!({ "kind": "shrinkTextOnOverflow", "fontScale": scale, "lineSpacingReduction": reduction });
    } else if tree.child(body_pr, NS_A, "spAutoFit").is_some() {
        let Some(ext) = tree.path(shape, &[(NS_P, "spPr"), (NS_A, "xfrm"), (NS_A, "ext")]) else {
            return Ok(json!({ "kind": "resizeShapeToFitText", "skipped": "position inherited from the layout" }));
        };
        let height = autofit::auto_height(&m, &res.fonts);
        let cy = (height * EMU_PER_PT).round() as i64;
        let n = tree.node(ext);
        let cx = n.attr("cx").unwrap_or("0").to_owned();
        edits.push((n.start..n.end, format!(r#"<{} cx="{cx}" cy="{cy}"/>"#, n.qname).into_bytes()));
        result = json!({ "kind": "resizeShapeToFitText", "height": height });
    } else {
        return Ok(Value::Null);
    }
    let updated = splice(&src, edits)?;
    check_scope(&src, &updated, tree.node(shape).start, tree.node(shape).end)?;
    doc.package_mut().write(&part, updated)?;
    Ok(result)
}

fn find_shape(tree: &Tree, parent: usize, id: u32) -> Option<usize> {
    for &child in &tree.node(parent).children {
        let node = tree.node(child);
        if node.ns.as_deref() != Some(NS_P) {
            continue;
        }
        if shape_id(tree, child) == Some(id) {
            return Some(child);
        }
        if node.local == "grpSp" {
            if let Some(found) = find_shape(tree, child, id) {
                return Some(found);
            }
        }
    }
    None
}

fn validate_text(text: &str) -> Result<(), Error> {
    // Tab and U+000B (line break inside a paragraph) are allowed.
    if let Some(c) = text.chars().find(|&c| c != '\t' && c != '\u{b}' && (c.is_control() || c == '\u{fffe}' || c == '\u{ffff}')) {
        return Err(Error::InvalidCommand(format!(
            "unsupported character U+{:04X} in paragraph text; use U+000B for a line break and separate strings for paragraphs",
            c as u32
        )));
    }
    Ok(())
}

/// Rewrites element `node`'s start tag so it is named `new_local` (same prefix).
fn renamed(tree: &Tree, src: &[u8], node: usize, new_local: &str) -> Vec<u8> {
    let n = tree.node(node);
    let new_name = format!("{}{}", n.prefix(), new_local);
    let mut out = Vec::new();
    out.extend_from_slice(b"<");
    out.extend_from_slice(new_name.as_bytes());
    out.extend_from_slice(&src[n.start + 1 + n.qname.len()..n.open_end]);
    if !n.is_empty_element() {
        out.extend_from_slice(&src[n.open_end..n.close_start]);
        out.extend_from_slice(format!("</{new_name}>").as_bytes());
    }
    out
}

/// Builds the bytes of paragraph `p` with its text replaced by `text`.
fn build_paragraph(tree: &Tree, src: &[u8], p: usize, text: &str) -> Result<Vec<u8>, Error> {
    let para = tree.node(p);
    let prefix = para.prefix();
    let mut ppr = None;
    let mut end_ppr = None;
    let mut first_run = None;
    for &c in &para.children {
        let n = tree.node(c);
        if n.is(NS_A, "pPr") {
            ppr = Some(c);
        } else if n.is(NS_A, "endParaRPr") {
            end_ppr = Some(c);
        } else if n.is(NS_A, "r") {
            first_run = first_run.or(Some(c));
        } else if n.is(NS_A, "br") || n.is(NS_A, "fld") {
        } else {
            return Err(Error::Unsupported(format!(
                "paragraph contains <{}>, which replace_text would drop",
                n.qname
            )));
        }
    }
    let mut out = Vec::new();
    if para.is_empty_element() {
        out.extend_from_slice(format!("<{}>", para.qname).as_bytes());
    } else {
        out.extend_from_slice(&src[para.start..para.open_end]);
    }
    if let Some(i) = ppr {
        out.extend_from_slice(&src[tree.node(i).start..tree.node(i).end]);
    }
    if !text.is_empty() {
        // The run's opening tag, properties and text element name; a line
        // break (U+000B) becomes <a:br> with the same properties.
        let (open, rpr, t_name, close) = match first_run {
            Some(r) => {
                let run = tree.node(r);
                if run.children.iter().any(|&c| !tree.node(c).is(NS_A, "rPr") && !tree.node(c).is(NS_A, "t")) {
                    return Err(Error::Unsupported("run contains elements other than rPr and t".into()));
                }
                let t_name = tree.child(r, NS_A, "t").map(|t| tree.node(t).qname.clone()).unwrap_or_else(|| format!("{}t", run.prefix()));
                let rpr = tree.child(r, NS_A, "rPr").map(|n| src[tree.node(n).start..tree.node(n).end].to_vec()).unwrap_or_default();
                (src[run.start..run.open_end].to_vec(), rpr, t_name, format!("</{}>", run.qname))
            }
            // An empty paragraph types with its end-of-paragraph formatting.
            None => (
                format!("<{prefix}r>").into_bytes(),
                end_ppr.map(|e| renamed(tree, src, e, "rPr")).unwrap_or_default(),
                format!("{prefix}t"),
                format!("</{prefix}r>"),
            ),
        };
        for (k, segment) in text.split('\u{b}').enumerate() {
            if k > 0 {
                out.extend_from_slice(format!("<{prefix}br>").as_bytes());
                out.extend_from_slice(&rpr);
                out.extend_from_slice(format!("</{prefix}br>").as_bytes());
            }
            if segment.is_empty() {
                continue;
            }
            out.extend_from_slice(&open);
            out.extend_from_slice(&rpr);
            out.extend_from_slice(format!("<{t_name}>{}</{t_name}>{close}", escape_text(segment)).as_bytes());
        }
    }
    if let Some(i) = end_ppr {
        out.extend_from_slice(&src[tree.node(i).start..tree.node(i).end]);
    } else if text.is_empty() {
        // An emptied paragraph keeps its first run's formatting, as
        // PowerPoint does when all text is deleted.
        if let Some(rpr) = first_run.and_then(|r| tree.child(r, NS_A, "rPr")) {
            out.extend_from_slice(&renamed(tree, src, rpr, "endParaRPr"));
        }
    }
    out.extend_from_slice(format!("</{}>", para.qname).as_bytes());
    Ok(out)
}

/// The edit that gives paragraph `p` the text `text` (see `build_paragraph`).
pub(super) fn paragraph_edits_one(tree: &Tree, src: &[u8], p: usize, text: &str) -> Result<Vec<(std::ops::Range<usize>, Vec<u8>)>, Error> {
    validate_text(text)?;
    Ok(vec![(tree.node(p).start..tree.node(p).end, build_paragraph(tree, src, p, text)?)])
}

/// Edits that give text body `body` (`p:txBody` or a table cell's
/// `a:txBody`) the paragraphs `wanted`; see `Command::ReplaceText`.
pub(super) fn paragraph_edits(tree: &Tree, src: &[u8], body: usize, wanted: &[String]) -> Result<Vec<(std::ops::Range<usize>, Vec<u8>)>, Error> {
    let existing: Vec<usize> = tree.children_named(body, NS_A, "p").collect();
    if existing.is_empty() {
        return Err(Error::Xml("text body has no paragraph".into()));
    }
    let current = paragraph_texts(tree, src, body)?;
    let mut edits = Vec::new();
    for (i, text) in wanted.iter().enumerate().take(existing.len()) {
        let p = existing[i];
        // A paragraph whose text is unchanged keeps its exact bytes, including
        // fields, line breaks and per-run formatting.
        if current[i] == *text {
            continue;
        }
        validate_text(text)?;
        edits.push((tree.node(p).start..tree.node(p).end, build_paragraph(tree, src, p, text)?));
    }
    let last = *existing.last().expect("checked non-empty");
    if wanted.len() > existing.len() {
        let mut added = Vec::new();
        for text in &wanted[existing.len()..] {
            validate_text(text)?;
            added.extend_from_slice(&build_paragraph(tree, src, last, text)?);
        }
        let at = tree.node(last).end;
        edits.push((at..at, added));
    } else if wanted.len() < existing.len() {
        let keep_end = tree.node(existing[wanted.len() - 1]).end;
        edits.push((keep_end..tree.node(last).end, Vec::new()));
    }
    Ok(edits)
}

fn replace_text(doc: &mut Presentation, slide: usize, id: u32, paragraphs: &[String]) -> Result<Value, Error> {
    let wanted: Vec<String> = if paragraphs.is_empty() { vec![String::new()] } else { paragraphs.to_vec() };
    let part = doc.slide_part(slide)?.to_owned();
    let src = doc.package().read(&part)?;
    let tree = Tree::parse(&src)?;
    let sp_tree = tree
        .path(tree.root, &[(NS_P, "cSld"), (NS_P, "spTree")])
        .ok_or_else(|| Error::NotFound(format!("shape tree in {part}")))?;
    let shape = find_shape(&tree, sp_tree, id).ok_or_else(|| Error::NotFound(format!("shape {id} on slide {slide}")))?;
    let body = tree
        .child(shape, NS_P, "txBody")
        .ok_or_else(|| Error::InvalidCommand(format!("shape {id} has no text body")))?;
    let edits = paragraph_edits(&tree, &src, body, &wanted)?;
    let changed = !edits.is_empty();
    if changed {
        let updated = splice(&src, edits)?;
        check_scope(&src, &updated, tree.node(shape).start, tree.node(shape).end)?;
        doc.package_mut().write(&part, updated)?;
    }

    let mut warnings = Vec::new();
    if let Some(body_pr) = tree.child(body, NS_A, "bodyPr") {
        if let Some(fit) = tree.child(body_pr, NS_A, "normAutofit") {
            if tree.node(fit).attr("fontScale").is_some() || tree.node(fit).attr("lnSpcReduction").is_some() {
                warnings.push("stored text shrink (normAutofit fontScale/lnSpcReduction) was not recomputed");
            }
        }
        if tree.child(body_pr, NS_A, "spAutoFit").is_some() {
            warnings.push("shape auto-size (spAutoFit) was not recomputed");
        }
    }
    Ok(json!({
        "op": "replace_text",
        "part": part,
        "slide": slide,
        "shapeId": id,
        "changed": changed,
        "paragraphs": wanted.len(),
        "warnings": warnings,
    }))
}

/// Fails if bytes outside `[start, end)` of the original differ.
fn check_scope(before: &[u8], after: &[u8], start: usize, end: usize) -> Result<(), Error> {
    let tail = before.len() - end;
    let ok = after.len() >= start + tail && after[..start] == before[..start] && after[after.len() - tail..] == before[end..];
    if ok {
        Ok(())
    } else {
        Err(Error::ScopeViolation(format!("edit changed bytes outside element {start}..{end}")))
    }
}
