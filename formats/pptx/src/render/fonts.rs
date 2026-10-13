//! Font selection for PPTX text.
//!
//! PPTX names fonts as authored, often in Korean ("맑은 고딕"). The font
//! database matches English family names, so this index maps every localized
//! family name in each font file to the file. Fonts are loaded on first use.
//! There is no implicit system fallback: when a requested font is missing,
//! the substitute comes from a fixed list and the result is marked, so adding
//! a font for one document cannot change another document's substitutes.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use designcraft_fonts::{FontDb, FontFace};
use skrifa::raw::{FileRef, TableProvider};
use skrifa::string::StringId;
use skrifa::MetadataProvider;

/// How the face used for a run relates to the authored font.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Fidelity {
    /// The authored family, in the requested weight and style.
    Exact,
    /// The authored family, but a different weight/style (PowerPoint would
    /// synthesize bold or italic).
    StyleSubstituted,
    /// The authored family is available but lacks this character, which is
    /// drawn with a fallback font (PowerPoint also falls back here; whether it
    /// picks the same font is not verified for every case).
    GlyphFallback,
    /// The authored family is not available; a different family is used and
    /// line breaks may differ from PowerPoint.
    Substituted,
    /// No available font draws this character.
    MissingGlyph,
}

/// Fixed substitute order for characters the authored font cannot draw.
const EAST_ASIAN_SUBSTITUTES: &[&str] = &["Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", "Noto Sans CJK KR"];
/// For East Asian characters in a run whose font is not sans serif (see
/// [`is_sans_serif`]): PowerPoint draws them in a serif (Myeongjo) face.
const EAST_ASIAN_SERIF_SUBSTITUTES: &[&str] = &["Batang", "AppleMyungjo", "Noto Serif KR", "Noto Serif CJK KR"];
const LATIN_SUBSTITUTES: &[&str] = &["Arial", "Helvetica", "Liberation Sans"];
/// Colour emoji fonts, for pictographs (as PowerPoint for Mac draws them
/// with Apple Color Emoji).
const EMOJI_SUBSTITUTES: &[&str] = &["Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", "Segoe UI Symbol"];

/// Pictographs and other characters drawn in a colour emoji font.
pub fn is_emoji(c: char) -> bool {
    matches!(c as u32, 0x1F000..=0x1FAFF | 0x2600..=0x27BF | 0x2B00..=0x2BFF | 0x2300..=0x23FF | 0xFE0F)
}

/// Where a font's bytes come from: a file on this machine (native) or bytes
/// handed over by the host (browser Local Font Access, document fonts).
#[derive(Debug, Clone, PartialEq)]
enum Source {
    File(PathBuf),
    Bytes(Arc<Vec<u8>>),
}

/// What a family name refers to.
#[derive(Debug, Default)]
struct Entry {
    /// English typographic family, as the font database names it.
    english: String,
    /// Indexes into `FontSet::sources`.
    sources: Vec<usize>,
    /// For a legacy family name that encodes a weight ("Gothic A1
    /// ExtraBold"): its legacy subfamily (Regular/Bold/Italic/Bold Italic)
    /// -> the typographic style that face has ("ExtraBold").
    legacy_styles: Vec<(String, String)>,
}

pub struct FontSet {
    db: FontDb,
    /// Lower-cased family name (any language) -> its fonts.
    index: HashMap<String, Entry>,
    loaded: Mutex<HashSet<usize>>,
    sources: Vec<Source>,
    /// Face chosen per (document scope, family, bold, italic); selection
    /// runs per text segment.
    chosen: Mutex<HashMap<(u32, String, bool, bool), Option<(Arc<FontFace>, Fidelity)>>>,
    /// Documents' own fonts (embedded in the file) per font database scope,
    /// by lower-cased family name. The active document's are found when no
    /// shared font has the name; other documents never see them.
    documents: HashMap<u32, HashMap<String, Entry>>,
    /// The scope of the document being drawn (0: none).
    active: AtomicU32,
}

impl FontSet {
    /// No fonts except the bundled interface fonts; add fonts with
    /// [`FontSet::add_file`] or [`FontSet::add_bytes`].
    pub fn empty() -> Self {
        let db = FontDb::with_font_dirs(Vec::new());
        db.set_system_fallback(false);
        Self {
            db,
            index: HashMap::new(),
            loaded: Mutex::new(HashSet::new()),
            sources: Vec::new(),
            chosen: Mutex::new(HashMap::new()),
            documents: HashMap::new(),
            active: AtomicU32::new(0),
        }
    }

    /// Fonts installed on this machine plus PowerPoint for Mac's bundled
    /// fonts when present (local development and comparison only).
    pub fn local() -> Self {
        let mut dirs = designcraft_fonts::system_font_dirs();
        let ppt = PathBuf::from("/Applications/Microsoft PowerPoint.app/Contents/Resources/DFonts");
        if ppt.is_dir() {
            dirs.push(ppt);
        }
        Self::from_dirs(&dirs)
    }

    pub fn from_dirs(dirs: &[PathBuf]) -> Self {
        let mut set = Self::empty();
        let mut files = Vec::new();
        for dir in dirs {
            collect_font_files(dir, &mut files);
        }
        files.sort();
        for path in files {
            if let Ok(data) = std::fs::read(&path) {
                set.register(&data, Source::File(path));
            }
        }
        set
    }

    /// Adds a font file's faces under all of their family names.
    pub fn add_file(&mut self, path: &Path) -> std::io::Result<()> {
        let data = std::fs::read(path)?;
        self.register(&data, Source::File(path.to_owned()));
        Ok(())
    }

    /// Adds font bytes (TTF/OTF/TTC) under all of their family names.
    pub fn add_bytes(&mut self, bytes: Vec<u8>) {
        let bytes = Arc::new(bytes);
        self.register(&bytes.clone(), Source::Bytes(bytes));
    }

    fn register(&mut self, data: &[u8], source: Source) {
        let key = match self.sources.iter().position(|s| *s == source) {
            Some(k) => k,
            None => {
                self.sources.push(source);
                self.sources.len() - 1
            }
        };
        self.chosen.get_mut().unwrap_or_else(|e| e.into_inner()).clear();
        for face in family_names(data) {
            for name in &face.names {
                let legacy = face.legacy_names.contains(name);
                let entry = self.index.entry(name.to_lowercase()).or_insert_with(|| Entry { english: face.english.clone(), ..Default::default() });
                if entry.english != face.english {
                    continue;
                }
                if !entry.sources.contains(&key) {
                    entry.sources.push(key);
                }
                if legacy {
                    let pair = (face.legacy_style.clone(), face.style.clone());
                    if !entry.legacy_styles.contains(&pair) {
                        entry.legacy_styles.push(pair);
                    }
                }
            }
        }
    }

    /// Adds one document's own fonts: `(typeface, TrueType bytes)` per font
    /// file, the typeface being the name the document gives it (each file is
    /// also found under its own family names). Returns the document's scope
    /// for [`FontSet::set_active_document`], or 0 when no font could be read.
    pub fn add_document_fonts(&mut self, fonts: Vec<(String, Vec<u8>)>) -> u32 {
        let mut document: HashMap<String, Entry> = HashMap::new();
        for (typeface, data) in &fonts {
            for face in family_names(data) {
                let mut names = face.names.clone();
                names.push(typeface.clone());
                for name in names {
                    let legacy = face.legacy_names.contains(&name) || (name == *typeface && !typeface.eq_ignore_ascii_case(&face.english));
                    let entry = document.entry(name.to_lowercase()).or_insert_with(|| Entry { english: face.english.clone(), ..Default::default() });
                    if entry.english != face.english {
                        continue;
                    }
                    if legacy {
                        let pair = (face.legacy_style.clone(), face.style.clone());
                        if !entry.legacy_styles.contains(&pair) {
                            entry.legacy_styles.push(pair);
                        }
                    }
                }
            }
        }
        let scope = self.db.open_scope(fonts.into_iter().map(|(_, b)| b).collect());
        if scope != 0 {
            self.documents.insert(scope, document);
        }
        scope
    }

    /// Removes a document's fonts (the document was closed).
    pub fn remove_document_fonts(&mut self, scope: u32) {
        if self.documents.remove(&scope).is_some() {
            self.db.close_scope(scope);
            self.chosen.get_mut().unwrap_or_else(|e| e.into_inner()).retain(|k, _| k.0 != scope);
        }
        let _ = self.active.compare_exchange(scope, 0, Ordering::Relaxed, Ordering::Relaxed);
    }

    /// Makes the fonts of the document with `scope` the ones found (0: no
    /// document's fonts).
    pub fn set_active_document(&self, scope: u32) {
        self.active.store(scope, Ordering::Relaxed);
    }

    fn document(&self) -> Option<&HashMap<String, Entry>> {
        self.documents.get(&self.active.load(Ordering::Relaxed))
    }

    pub fn db(&self) -> &FontDb {
        &self.db
    }

    /// What `family` names and the font scope to look its faces up in. An
    /// installed (shared) font comes before the document's own copy, as in
    /// PowerPoint, which draws a character missing from an embedded subset
    /// with the installed font of that name.
    fn entry(&self, family: &str) -> Option<(&Entry, u32)> {
        let key = family.trim().to_lowercase();
        match self.index.get(&key) {
            Some(e) => Some((e, 0)),
            None => self.document().and_then(|d| d.get(&key)).map(|e| (e, self.active.load(Ordering::Relaxed))),
        }
    }

    fn english(&self, family: &str) -> Option<(String, u32)> {
        let (entry, scope) = self.entry(family)?;
        if scope != 0 {
            return Some((entry.english.clone(), scope));
        }
        let (english, sources) = (&entry.english, &entry.sources);
        let mut loaded = self.loaded.lock().unwrap_or_else(|e| e.into_inner());
        for &key in sources {
            if loaded.insert(key) {
                let bytes = match &self.sources[key] {
                    Source::File(p) => std::fs::read(p).ok(),
                    Source::Bytes(b) => Some(b.as_ref().clone()),
                };
                if let Some(bytes) = bytes {
                    self.db.add_font(bytes);
                }
            }
        }
        Some((english.clone(), 0))
    }

    /// The face of `family` closest to the requested weight and style, if the
    /// family is available.
    pub fn family_face(&self, family: &str, bold: bool, italic: bool) -> Option<(Arc<FontFace>, Fidelity)> {
        let key = (self.active.load(Ordering::Relaxed), family.trim().to_lowercase(), bold, italic);
        if let Some(hit) = self.chosen.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            return hit.clone();
        }
        let found = self.select(family, bold, italic);
        self.chosen.lock().unwrap_or_else(|e| e.into_inner()).insert(key, found.clone());
        found
    }

    fn select(&self, family: &str, bold: bool, italic: bool) -> Option<(Arc<FontFace>, Fidelity)> {
        let (english, scope) = self.english(family)?;
        // A legacy name like "Gothic A1 ExtraBold" names one face per
        // Regular/Bold/Italic/Bold Italic slot; pick that face directly.
        let fonts = self.db.scoped(scope);
        let legacy = &self.entry(family)?.0.legacy_styles;
        if !legacy.is_empty() {
            let want = match (bold, italic) {
                (false, false) => "Regular",
                (true, false) => "Bold",
                (false, true) => "Italic",
                (true, true) => "Bold Italic",
            };
            let exact = legacy.iter().find(|(l, _)| l.eq_ignore_ascii_case(want));
            let (_, style) = exact.or_else(|| legacy.iter().find(|(l, _)| l.eq_ignore_ascii_case("Regular"))).or(legacy.first())?;
            let face = fonts.face(&english, style);
            if face.family.eq_ignore_ascii_case(&english) && face.style.eq_ignore_ascii_case(style) {
                return Some((face, if exact.is_some() { Fidelity::Exact } else { Fidelity::StyleSubstituted }));
            }
        }
        let want_weight = if bold { 700.0 } else { 400.0 };
        let best = fonts
            .styles(&english)
            .iter()
            .map(|s| fonts.face(&english, s))
            .filter(|f| f.family.eq_ignore_ascii_case(&english) && f.coords.is_empty())
            .min_by(|a, b| {
                let score = |f: &FontFace| (f.weight - want_weight).abs() + if f.italic == italic { 0.0 } else { 1000.0 };
                score(a).total_cmp(&score(b))
            })?;
        let exact = (best.weight >= 600.0) == bold && best.italic == italic;
        Some((best, if exact { Fidelity::Exact } else { Fidelity::StyleSubstituted }))
    }

    /// The face to draw `c` with when the authored face lacks it.
    pub fn substitute_for(&self, c: char, bold: bool, italic: bool) -> Option<Arc<FontFace>> {
        self.substitute_in_style(c, bold, italic, true)
    }

    /// [`FontSet::substitute_for`] for a run whose font is sans serif or not
    /// (East Asian characters only; measured on PowerPoint for Mac: Hangul
    /// in Lato, Noto Sans, Arial, Calibri or Trebuchet MS runs is drawn in
    /// Malgun Gothic, in Roboto or Playfair Display runs in Batang).
    pub fn substitute_in_style(&self, c: char, bold: bool, italic: bool, sans: bool) -> Option<Arc<FontFace>> {
        let list = match (is_east_asian(c), sans) {
            (true, true) => EAST_ASIAN_SUBSTITUTES,
            (true, false) => EAST_ASIAN_SERIF_SUBSTITUTES,
            _ => LATIN_SUBSTITUTES,
        };
        let emoji: &[&str] = if is_emoji(c) { EMOJI_SUBSTITUTES } else { &[] };
        emoji.iter().chain(list).filter_map(|f| self.family_face(f, bold, italic)).map(|(f, _)| f).find(|f| f.covers(c))
    }
}

fn collect_font_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_font_files(&p, out);
        } else if matches!(p.extension().and_then(|x| x.to_str()).map(|x| x.to_ascii_lowercase()).as_deref(), Some("ttf" | "otf" | "ttc")) {
            out.push(p);
        }
    }
}

struct FaceNames {
    /// English typographic family, as the font database names it.
    english: String,
    /// Typographic style ("ExtraBold"), as the font database names it.
    style: String,
    /// Every localized family name, typographic and legacy.
    names: Vec<String>,
    /// Legacy family names (name ID 1) that differ from the typographic family.
    legacy_names: Vec<String>,
    /// Legacy subfamily (name ID 2): Regular, Bold, Italic or Bold Italic.
    legacy_style: String,
}

fn english_name(font: &skrifa::FontRef<'_>, ids: &[StringId]) -> Option<String> {
    ids.iter().find_map(|id| font.localized_strings(*id).english_or_first().map(|s| s.to_string()).filter(|s| !s.is_empty()))
}

/// Names of each face in a font file.
fn family_names(data: &[u8]) -> Vec<FaceNames> {
    let Ok(file) = FileRef::new(data) else { return Vec::new() };
    file.fonts()
        .flatten()
        .filter_map(|font| {
            // Skip variable fonts: their named instances are separate faces.
            if font.fvar().is_ok() {
                return None;
            }
            let english = english_name(&font, &[StringId::TYPOGRAPHIC_FAMILY_NAME, StringId::FAMILY_NAME])?;
            let style = english_name(&font, &[StringId::TYPOGRAPHIC_SUBFAMILY_NAME, StringId::SUBFAMILY_NAME]).unwrap_or_else(|| "Regular".into());
            let legacy_style = english_name(&font, &[StringId::SUBFAMILY_NAME]).unwrap_or_else(|| "Regular".into());
            let mut names = vec![english.clone()];
            let mut legacy_names = Vec::new();
            for id in [StringId::TYPOGRAPHIC_FAMILY_NAME, StringId::FAMILY_NAME] {
                for s in font.localized_strings(id) {
                    let s = s.to_string();
                    if s.is_empty() {
                        continue;
                    }
                    if id == StringId::FAMILY_NAME && !s.eq_ignore_ascii_case(&english) && !legacy_names.contains(&s) {
                        legacy_names.push(s.clone());
                    }
                    if !names.contains(&s) {
                        names.push(s);
                    }
                }
            }
            Some(FaceNames { english, style, names, legacy_names, legacy_style })
        })
        .collect()
}

/// Whether a face declares itself sans serif: PANOSE Latin text with a
/// sans serif style (normal, obtuse, perpendicular, flared or rounded).
/// Fonts that leave the style unset ("any") count as serif, as PowerPoint
/// treats Roboto (PANOSE 2 0 ...) when picking an East Asian substitute.
pub fn is_sans_serif(face: &FontFace) -> bool {
    face.skrifa().and_then(|f| f.os2().ok()).is_some_and(|o| matches!(o.panose_10(), [2, 11..=15, ..]))
}

/// Characters PowerPoint sets with the East Asian (`a:ea`) font.
pub fn is_east_asian(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x11FF | 0x2E80..=0x2FDF | 0x3000..=0x303F | 0x3040..=0x30FF | 0x3130..=0x318F |
        0x3190..=0x31FF | 0x3200..=0x33FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xA960..=0xA97F |
        0xAC00..=0xD7FF | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFFEF | 0x20000..=0x2FFFF)
}

/// Underline thickness and strikeout position and thickness of a face, in
/// ems (`post` and `OS/2`; common defaults when a table is missing).
pub fn decoration_metrics(face: &FontFace) -> (f64, f64, f64) {
    let upm = face.units_per_em().max(1.0);
    let font = face.skrifa();
    let underline = font.as_ref().and_then(|f| f.post().ok()).map(|p| p.underline_thickness().to_i16() as f64 / upm).filter(|v| *v > 0.0).unwrap_or(0.05);
    let os2 = font.as_ref().and_then(|f| f.os2().ok());
    let strike_pos = os2.as_ref().map(|o| o.y_strikeout_position() as f64 / upm).filter(|v| *v > 0.0).unwrap_or(0.26);
    let strike_size = os2.as_ref().map(|o| o.y_strikeout_size() as f64 / upm).filter(|v| *v > 0.0).unwrap_or(0.05);
    (underline, strike_pos, strike_size)
}
