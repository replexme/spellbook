//! Recomputes autofit after a text edit, the way PowerPoint does while
//! editing (PowerPoint applies stored values on open and never recomputes
//! them then, so the editor must write them).
//!
//! Measured from PowerPoint for Mac 16.109.1 rewriting text itself
//! (conformance/results/2026-10-11-autofit.md):
//! - Shrink text on overflow (`normAutofit`): PowerPoint tries line spacing
//!   reductions of 10% and 20%, then, keeping 20%, font scales in 2.5% steps
//!   down to 25%. Here the first setting in that order whose text fits is
//!   used. PowerPoint's own pick matched in 25 of 33 cases and was otherwise
//!   one or two steps away (its search is not simply "first fit"); in all 33
//!   cases PowerPoint draws our value with the same lines and no overflow.
//!   Since PowerPoint applies stored values on open, the file then looks as
//!   our screen shows it.
//! - Resize shape to fit text (`spAutoFit`): the height becomes the insets
//!   plus the text's fit height; the top stays.

use super::fonts::FontSet;
use super::text::{self, BodyProps};
use super::TextMeasure;

fn fit_height(m: &TextMeasure, fonts: &FontSet, scale: f64, reduction: f64) -> f64 {
    let body = BodyProps { font_scale: scale, line_reduction: reduction, ..m.body.clone() };
    text::layout(&m.paragraphs, &body, m.width, m.height, fonts, &m.theme).fit_height
}

/// (font scale, line spacing reduction) for a `normAutofit` box; (1, 0)
/// when the text fits as is.
pub fn shrink(m: &TextMeasure, fonts: &FontSet) -> (f64, f64) {
    let inner = m.height - m.body.insets[1] - m.body.insets[3];
    let fits = |s: f64, r: f64| fit_height(m, fonts, s, r) <= inner + 0.01;
    if fits(1.0, 0.0) {
        return (1.0, 0.0);
    }
    for r in [0.1, 0.2] {
        if fits(1.0, r) {
            return (1.0, r);
        }
    }
    let mut step = 39; // 97.5% .. 25% in 2.5% steps
    while step >= 10 {
        let s = step as f64 * 0.025;
        if fits(s, 0.2) {
            return (s, 0.2);
        }
        step -= 1;
    }
    (0.25, 0.2)
}

/// Height in points of a `spAutoFit` box holding the text.
pub fn auto_height(m: &TextMeasure, fonts: &FontSet) -> f64 {
    m.body.insets[1] + m.body.insets[3] + fit_height(m, fonts, 1.0, 0.0)
}
