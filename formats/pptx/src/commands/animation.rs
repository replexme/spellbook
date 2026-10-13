//! Slide animations: the main sequence of `p:timing` (what plays on clicks)
//! as a flat list of effects, as PowerPoint's animation pane shows it.
//!
//! Effects are added from markup PowerPoint itself wrote for each preset
//! (`data/animationEffects.xml`). An edit reads the list, changes it and
//! writes the main sequence again with PowerPoint's grouping: an effect that
//! starts on click opens a click group; "with previous" joins the previous
//! effect's time group; "after previous" opens a time group that starts when
//! the previous one ends. Existing effects keep their markup; only their
//! start type, delay, duration and node ids change. Other sequences
//! (triggered by clicking a shape) are kept as they are.

use std::sync::OnceLock;

use serde::Serialize;
use serde_json::{json, Value};

use super::check_scope;
use super::xmledit::start_tag;
use crate::xml::{splice, Tree, NS_P};
use crate::{Error, Presentation};

const EFFECTS: &str = include_str!("../../data/animationEffects.xml");

/// When an effect starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Start {
    OnClick,
    WithPrevious,
    AfterPrevious,
}

impl Start {
    pub fn parse(s: &str) -> Result<Self, Error> {
        match s {
            "onClick" => Ok(Start::OnClick),
            "withPrevious" => Ok(Start::WithPrevious),
            "afterPrevious" => Ok(Start::AfterPrevious),
            other => Err(Error::InvalidCommand(format!("start must be onClick, withPrevious or afterPrevious, got {other:?}"))),
        }
    }

    fn node_type(self) -> &'static str {
        match self {
            Start::OnClick => "clickEffect",
            Start::WithPrevious => "withEffect",
            Start::AfterPrevious => "afterEffect",
        }
    }

    fn from_node_type(t: Option<&str>) -> Self {
        match t {
            Some("withEffect") => Start::WithPrevious,
            Some("afterEffect") => Start::AfterPrevious,
            _ => Start::OnClick,
        }
    }
}

/// A preset effect PowerPoint wrote: class and name as commands use them.
struct Template {
    class: String,
    name: String,
    preset_id: String,
    preset_class: String,
    preset_subtype: String,
    /// The effect node's `fill` (empty when PowerPoint writes none).
    fill: String,
    /// The effect's `p:childTnLst`, with `{spid}` for the target.
    body: String,
}

fn templates() -> &'static Vec<Template> {
    static T: OnceLock<Vec<Template>> = OnceLock::new();
    T.get_or_init(|| {
        let tree = Tree::parse(EFFECTS.as_bytes()).expect("bundled animation effects parse");
        tree.node(tree.root)
            .children
            .iter()
            .map(|&e| {
                let n = tree.node(e);
                let a = |k: &str| n.attr(k).unwrap_or_default().to_owned();
                Template { class: a("class"), name: a("name"), preset_id: a("presetID"), preset_class: a("presetClass"), preset_subtype: a("presetSubtype"), fill: a("fill"), body: EFFECTS[n.open_end..n.close_start].to_owned() }
            })
            .collect()
    })
}

fn template(class: &str, name: &str) -> Result<&'static Template, Error> {
    templates().iter().find(|t| t.class == class && t.name == name).ok_or_else(|| {
        let names: Vec<String> = templates().iter().filter(|t| t.class == class).map(|t| t.name.clone()).collect();
        if names.is_empty() {
            Error::InvalidCommand(format!("class must be entrance, emphasis or exit, got {class:?}"))
        } else {
            Error::InvalidCommand(format!("{class} effect {name:?}; one of {}", names.join(", ")))
        }
    })
}

/// One effect of the main sequence: its `p:par` markup and what the
/// sequence needs to know about it.
#[derive(Clone)]
struct Effect {
    xml: String,
    start: Start,
    /// Delay after its start, ms.
    delay: f64,
    /// Time from its start to its end (after the delay), ms.
    duration: f64,
    spid: Option<u32>,
    grp: Option<u32>,
}

/// An effect as `observe` reports it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnimationInfo {
    pub index: usize,
    pub shape_id: Option<u32>,
    /// `entrance`, `emphasis`, `exit`, `path` or the file's own class.
    pub class: String,
    /// The preset name when it is one of the presets this engine adds.
    pub effect: Option<String>,
    pub preset_id: Option<u32>,
    pub start: Start,
    /// Seconds.
    pub delay: f64,
    pub duration: f64,
}

/// Parses `xml` (markup taken from a slide) inside the slide's root start
/// tag so its prefixes resolve; returns the source and tree.
fn fragment(root_tag: &str, root_end: &str, xml: &str) -> Result<(String, Tree), Error> {
    let src = format!("{root_tag}{xml}{root_end}");
    let tree = Tree::parse(src.as_bytes())?;
    Ok((src, tree))
}

fn descendants(tree: &Tree, node: usize, out: &mut Vec<usize>) {
    for &c in &tree.node(node).children {
        out.push(c);
        descendants(tree, c, out);
    }
}

fn num(v: Option<&str>) -> Option<f64> {
    v.and_then(|v| v.parse::<f64>().ok())
}

/// The effect `cTn` of an effect `p:par`.
fn effect_ctn(tree: &Tree, par: usize) -> Option<usize> {
    tree.child(par, NS_P, "cTn")
}

fn own_delay(tree: &Tree, ctn: usize) -> f64 {
    tree.path(ctn, &[(NS_P, "stCondLst"), (NS_P, "cond")]).and_then(|c| num(tree.node(c).attr("delay"))).unwrap_or(0.0)
}

/// Length of an effect from its start, ms: the latest end of its timed nodes.
fn length(tree: &Tree, ctn: usize) -> f64 {
    let Some(body) = tree.child(ctn, NS_P, "childTnLst") else { return 0.0 };
    let mut nodes = Vec::new();
    descendants(tree, body, &mut nodes);
    nodes.into_iter().filter(|&n| tree.node(n).is(NS_P, "cTn")).filter_map(|n| num(tree.node(n).attr("dur")).map(|d| own_delay(tree, n) + d)).fold(0.0, f64::max)
}

fn read_effect(tree: &Tree, src: &str, par: usize) -> Option<Effect> {
    let ctn = effect_ctn(tree, par)?;
    let n = tree.node(ctn);
    n.attr("presetClass")?;
    let mut nodes = Vec::new();
    descendants(tree, ctn, &mut nodes);
    let spid = nodes.iter().find(|&&d| tree.node(d).is(NS_P, "spTgt")).and_then(|&d| tree.node(d).attr("spid")).and_then(|v| v.parse().ok());
    let p = tree.node(par);
    Some(Effect {
        xml: src[p.start..p.end].to_owned(),
        start: Start::from_node_type(n.attr("nodeType")),
        delay: own_delay(tree, ctn),
        duration: length(tree, ctn),
        spid,
        grp: num(n.attr("grpId")).map(|g| g as u32),
    })
}

/// The slide's timing, parsed.
struct Timing {
    part: String,
    src: Vec<u8>,
    tree: Tree,
    root_tag: String,
    root_end: String,
    timing: Option<usize>,
    /// The main sequence's `p:seq` and its `cTn`.
    main: Option<(usize, usize)>,
    effects: Vec<Effect>,
    next_id: u32,
}

fn read_timing(doc: &Presentation, slide: usize) -> Result<Timing, Error> {
    let part = doc.slide_part(slide)?.to_owned();
    let src = doc.package().read(&part)?.to_vec();
    let tree = Tree::parse(&src)?;
    let root = tree.node(tree.root);
    if root.prefix() != "p:" {
        return Err(Error::Unsupported("slide markup without the usual p: prefix".into()));
    }
    let text = std::str::from_utf8(&src).map_err(|e| Error::Xml(e.to_string()))?;
    let root_tag = text[root.start..root.open_end].to_owned();
    let root_end = format!("</{}>", root.qname);
    let timing = tree.child(tree.root, NS_P, "timing");
    let mut main = None;
    let mut effects = Vec::new();
    let mut next_id = 0;
    if let Some(t) = timing {
        let mut nodes = Vec::new();
        descendants(&tree, t, &mut nodes);
        next_id = nodes.iter().filter(|&&n| tree.node(n).is(NS_P, "cTn")).filter_map(|&n| num(tree.node(n).attr("id"))).fold(0.0, f64::max) as u32;
        let ctn = nodes.iter().copied().find(|&n| tree.node(n).is(NS_P, "cTn") && tree.node(n).attr("nodeType") == Some("mainSeq"));
        if let Some(ctn) = ctn {
            let seq = tree.node(ctn).parent.filter(|&s| tree.node(s).is(NS_P, "seq")).ok_or_else(|| Error::Xml("main sequence outside p:seq".into()))?;
            main = Some((seq, ctn));
            for click in tree.child(ctn, NS_P, "childTnLst").map(|l| tree.children_named(l, NS_P, "par").collect::<Vec<_>>()).unwrap_or_default() {
                let groups = tree.path(click, &[(NS_P, "cTn"), (NS_P, "childTnLst")]).map(|l| tree.children_named(l, NS_P, "par").collect::<Vec<_>>()).unwrap_or_default();
                for group in groups {
                    let pars = tree.path(group, &[(NS_P, "cTn"), (NS_P, "childTnLst")]).map(|l| tree.children_named(l, NS_P, "par").collect::<Vec<_>>()).unwrap_or_default();
                    for par in pars {
                        effects.push(read_effect(&tree, text, par).ok_or_else(|| Error::Unsupported("main sequence holds a node that is not a preset effect".into()))?);
                    }
                }
            }
        }
    }
    Ok(Timing { part, src, tree, root_tag, root_end, timing, main, effects, next_id })
}

/// Lists the main sequence of slide `slide`.
pub fn slide_animations(doc: &Presentation, slide: usize) -> Result<Vec<AnimationInfo>, Error> {
    let t = read_timing(doc, slide)?;
    t.effects
        .iter()
        .enumerate()
        .map(|(index, e)| {
            let (_, tree) = fragment(&t.root_tag, &t.root_end, &e.xml)?;
            let ctn = tree.node(tree.root).children.first().and_then(|&p| effect_ctn(&tree, p)).ok_or_else(|| Error::Xml("effect without cTn".into()))?;
            let n = tree.node(ctn);
            let class = match n.attr("presetClass").unwrap_or_default() {
                "entr" => "entrance",
                "emph" => "emphasis",
                "exit" => "exit",
                other => other,
            }
            .to_owned();
            let preset_id: Option<u32> = n.attr("presetID").and_then(|v| v.parse().ok());
            let effect = templates().iter().find(|tp| tp.class == class && tp.preset_id == n.attr("presetID").unwrap_or_default()).map(|tp| tp.name.clone());
            Ok(AnimationInfo { index, shape_id: e.spid, class, effect, preset_id, start: e.start, delay: e.delay / 1000.0, duration: e.duration / 1000.0 })
        })
        .collect()
}

/// Rewrites `e` with `attrs` set on chosen nodes: `pick` returns, for the
/// parsed effect, the nodes and the attributes to set on each.
fn edit_effect(t: &Timing, xml: &str, pick: impl Fn(&Tree, usize) -> Vec<(usize, Vec<(&'static str, Option<String>)>)>) -> Result<String, Error> {
    let (src, tree) = fragment(&t.root_tag, &t.root_end, xml)?;
    let par = *tree.node(tree.root).children.first().ok_or_else(|| Error::Xml("empty effect".into()))?;
    let mut edits = Vec::new();
    for (node, attrs) in pick(&tree, par) {
        let n = tree.node(node);
        let empty = n.open_end == n.end;
        edits.push((n.start..n.open_end, start_tag(src.as_bytes(), &tree, node, &attrs, empty)?));
    }
    let out = splice(src.as_bytes(), edits)?;
    let out = String::from_utf8(out).map_err(|e| Error::Xml(e.to_string()))?;
    Ok(out[t.root_tag.len()..out.len() - t.root_end.len()].to_owned())
}

/// Gives every `cTn` of the effect a fresh id.
fn renumber(t: &Timing, xml: &str, next: &mut u32) -> Result<String, Error> {
    let first = *next + 1;
    let (_, tree) = fragment(&t.root_tag, &t.root_end, xml)?;
    let count = tree.nodes.iter().filter(|n| n.is(NS_P, "cTn")).count() as u32;
    *next += count;
    edit_effect(t, xml, |tree, par| {
        let mut nodes = vec![par];
        descendants(tree, par, &mut nodes);
        nodes.into_iter().filter(|&n| tree.node(n).is(NS_P, "cTn")).enumerate().map(|(k, n)| (n, vec![("id", Some((first + k as u32).to_string()))])).collect()
    })
}

fn ms(v: f64) -> String {
    (v.round() as i64).to_string()
}

/// Sets the effect's start type and delay, and stretches its timing to
/// `duration` (ms) when given.
fn retime(t: &Timing, e: &mut Effect, start: Start, delay: f64, duration: Option<f64>) -> Result<(), Error> {
    if duration.is_some() && e.duration <= 1.0 {
        return Err(Error::InvalidCommand("the effect is instant (such as appear or disappear) and has no duration".into()));
    }
    let factor = match duration {
        Some(d) if e.duration > 0.0 => d / e.duration,
        _ => 1.0,
    };
    e.xml = edit_effect(t, &e.xml, |tree, par| {
        let Some(ctn) = effect_ctn(tree, par) else { return Vec::new() };
        let mut out = vec![(ctn, vec![("nodeType", Some(start.node_type().to_owned()))])];
        if let Some(c) = tree.path(ctn, &[(NS_P, "stCondLst"), (NS_P, "cond")]) {
            out.push((c, vec![("delay", Some(ms(delay)))]));
        }
        if factor != 1.0 {
            let mut nodes = Vec::new();
            if let Some(body) = tree.child(ctn, NS_P, "childTnLst") {
                descendants(tree, body, &mut nodes);
            }
            for n in nodes {
                let node = tree.node(n);
                // A one-millisecond `set` is an instant switch; keep it.
                if node.is(NS_P, "cTn") {
                    if let Some(d) = num(node.attr("dur")).filter(|d| *d > 1.0) {
                        out.push((n, vec![("dur", Some(ms(d * factor)))]));
                    }
                }
                if node.is(NS_P, "cond") && tree.node(node.parent.unwrap()).is(NS_P, "stCondLst") {
                    if let Some(d) = num(node.attr("delay")).filter(|d| *d > 0.0) {
                        out.push((n, vec![("delay", Some(ms(d * factor)))]));
                    }
                }
            }
        }
        out
    })?;
    e.start = start;
    e.delay = delay;
    if let Some(d) = duration {
        e.duration = d;
    }
    Ok(())
}

/// The main sequence's `p:childTnLst` content for `effects`.
fn assemble(effects: &[Effect], main_id: &str, next: &mut u32) -> String {
    let mut id = || {
        *next += 1;
        *next
    };
    struct Group<'a> {
        delay: f64,
        effects: Vec<&'a Effect>,
    }
    let mut clicks: Vec<(bool, Vec<Group>)> = Vec::new();
    for (i, e) in effects.iter().enumerate() {
        match (i, e.start) {
            (0, s) => clicks.push((s != Start::OnClick, vec![Group { delay: 0.0, effects: vec![e] }])),
            (_, Start::OnClick) => clicks.push((false, vec![Group { delay: 0.0, effects: vec![e] }])),
            (_, Start::WithPrevious) => clicks.last_mut().unwrap().1.last_mut().unwrap().effects.push(e),
            (_, Start::AfterPrevious) => {
                let groups = &mut clicks.last_mut().unwrap().1;
                let last = groups.last().unwrap();
                let end = last.effects.iter().map(|e| e.delay + e.duration).fold(0.0, f64::max);
                let delay = last.delay + end;
                groups.push(Group { delay, effects: vec![e] });
            }
        }
    }
    let mut out = String::new();
    for (auto, groups) in clicks {
        let begin = if auto { format!(r#"<p:cond evt="onBegin" delay="0"><p:tn val="{main_id}"/></p:cond>"#) } else { String::new() };
        out.push_str(&format!(r#"<p:par><p:cTn id="{}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/>{begin}</p:stCondLst><p:childTnLst>"#, id()));
        for g in groups {
            out.push_str(&format!(r#"<p:par><p:cTn id="{}" fill="hold"><p:stCondLst><p:cond delay="{}"/></p:stCondLst><p:childTnLst>"#, id(), ms(g.delay)));
            for e in g.effects {
                out.push_str(&e.xml);
            }
            out.push_str("</p:childTnLst></p:cTn></p:par>");
        }
        out.push_str("</p:childTnLst></p:cTn></p:par>");
    }
    out
}

const NEXT_PREV: &str = r#"<p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>"#;

/// Writes `effects` as the slide's main sequence, adding build entries
/// `add_builds` (spid, grpId) and dropping build entries no effect uses.
fn write(doc: &mut Presentation, t: Timing, effects: Vec<Effect>, add_builds: &[(u32, u32)]) -> Result<bool, Error> {
    let src = t.src.clone();
    let tree = &t.tree;
    // Ids 1 and 2 are the root and main sequence of a new timing.
    let mut next = t.next_id.max(2);
    let mut edits: Vec<(std::ops::Range<usize>, Vec<u8>)> = Vec::new();
    // Every (spid, grpId) still animated anywhere in the timing.
    let mut used: Vec<(u32, u32)> = effects.iter().filter_map(|e| Some((e.spid?, e.grp?))).collect();
    if let Some(timing) = t.timing {
        let mut nodes = Vec::new();
        descendants(tree, timing, &mut nodes);
        let inside_main = |n: usize| {
            let mut at = Some(n);
            while let Some(a) = at {
                if Some(a) == t.main.map(|m| m.0) {
                    return true;
                }
                at = tree.node(a).parent;
            }
            false
        };
        for &n in &nodes {
            let node = tree.node(n);
            if node.is(NS_P, "cTn") && node.attr("presetClass").is_some() && !inside_main(n) {
                let mut inner = Vec::new();
                descendants(tree, n, &mut inner);
                let spid = inner.iter().find(|&&d| tree.node(d).is(NS_P, "spTgt")).and_then(|&d| num(tree.node(d).attr("spid")));
                if let (Some(s), Some(g)) = (spid, num(node.attr("grpId"))) {
                    used.push((s as u32, g as u32));
                }
            }
        }
    }
    used.extend_from_slice(add_builds);
    let builds_xml: String = add_builds.iter().map(|(s, g)| format!(r#"<p:bldP spid="{s}" grpId="{g}" animBg="1"/>"#)).collect();

    match (t.timing, t.main) {
        (Some(timing), Some((seq, ctn))) => {
            let others = tree.node(tree.node(seq).parent.unwrap()).children.len() > 1;
            if effects.is_empty() && !others {
                // No animation left: PowerPoint writes no timing at all.
                let n = tree.node(timing);
                edits.push((n.start..n.end, Vec::new()));
            } else if effects.is_empty() {
                let n = tree.node(seq);
                edits.push((n.start..n.end, Vec::new()));
            } else {
                let list = tree.child(ctn, NS_P, "childTnLst").ok_or_else(|| Error::Xml("main sequence without childTnLst".into()))?;
                let main_id = tree.node(ctn).attr("id").unwrap_or("2").to_owned();
                let n = tree.node(list);
                let body = assemble(&effects, &main_id, &mut next);
                edits.push((n.start..n.end, format!("<p:childTnLst>{body}</p:childTnLst>").into_bytes()));
            }
            if !(effects.is_empty() && !others) {
                build_edits(tree, timing, &used, &builds_xml, &mut edits);
            }
        }
        (Some(timing), None) => {
            if effects.is_empty() {
                return Ok(false);
            }
            // No main sequence (other sequences only, or an empty root):
            // put it first under the root time node.
            let root = tree.path(timing, &[(NS_P, "tnLst"), (NS_P, "par"), (NS_P, "cTn")]).ok_or_else(|| Error::Xml("timing without a root time node".into()))?;
            next += 1;
            let main_id = next.to_string();
            let body = assemble(&effects, &main_id, &mut next);
            let seq = format!(r#"<p:seq concurrent="1" nextAc="seek"><p:cTn id="{main_id}" dur="indefinite" nodeType="mainSeq"><p:childTnLst>{body}</p:childTnLst></p:cTn>{NEXT_PREV}</p:seq>"#);
            let r = tree.node(root);
            match tree.child(root, NS_P, "childTnLst") {
                Some(list) => {
                    let at = tree.node(list).open_end;
                    edits.push((at..at, seq.into_bytes()));
                }
                None if r.open_end == r.end => {
                    let tag = start_tag(&src, tree, root, &[], false)?;
                    edits.push((r.start..r.end, [tag, format!("<p:childTnLst>{seq}</p:childTnLst></{}>", r.qname).into_bytes()].concat()));
                }
                None => {
                    // Before a sub-time-node list, else last.
                    let at = tree.child(root, NS_P, "subTnLst").map(|s| tree.node(s).start).unwrap_or(r.close_start);
                    edits.push((at..at, format!("<p:childTnLst>{seq}</p:childTnLst>").into_bytes()));
                }
            }
            build_edits(tree, timing, &used, &builds_xml, &mut edits);
        }
        (None, _) => {
            if effects.is_empty() {
                return Ok(false);
            }
            let body = assemble(&effects, "2", &mut next);
            let blds = if builds_xml.is_empty() { String::new() } else { format!("<p:bldLst>{builds_xml}</p:bldLst>") };
            let xml = format!(r#"<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>{body}</p:childTnLst></p:cTn>{NEXT_PREV}</p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>{blds}</p:timing>"#);
            // All ids are new: number them in document order, as PowerPoint
            // writes them.
            let xml = edit_effect(&t, &xml, |tree, top| {
                let mut nodes = vec![top];
                descendants(tree, top, &mut nodes);
                nodes.into_iter().filter(|&n| tree.node(n).is(NS_P, "cTn")).enumerate().map(|(k, n)| (n, vec![("id", Some((k + 1).to_string()))])).collect()
            })?;
            // After the transition, before the extension list.
            let root = tree.node(tree.root);
            let at = tree.child(tree.root, NS_P, "extLst").map(|e| tree.node(e).start).unwrap_or(root.close_start);
            edits.push((at..at, xml.into_bytes()));
        }
    }
    let scope = match t.timing {
        Some(n) => (tree.node(n).start, tree.node(n).end),
        None => {
            let at = edits[0].0.start;
            (at, at)
        }
    };
    let updated = splice(&src, edits)?;
    check_scope(&src, &updated, scope.0, scope.1)?;
    let changed = updated != src;
    doc.package_mut().write(&t.part, updated)?;
    Ok(changed)
}

/// Build-list edits: drop entries no effect uses, add `builds_xml`.
fn build_edits(tree: &Tree, timing: usize, used: &[(u32, u32)], builds_xml: &str, edits: &mut Vec<(std::ops::Range<usize>, Vec<u8>)>) {
    match tree.child(timing, NS_P, "bldLst") {
        Some(list) => {
            for &b in &tree.node(list).children {
                let n = tree.node(b);
                let key = (num(n.attr("spid")), num(n.attr("grpId")));
                if let (Some(s), Some(g)) = key {
                    if !used.contains(&(s as u32, g as u32)) {
                        edits.push((n.start..n.end, Vec::new()));
                    }
                }
            }
            if !builds_xml.is_empty() {
                let n = tree.node(list);
                if n.open_end == n.end {
                    edits.push((n.start..n.end, format!("<p:bldLst>{builds_xml}</p:bldLst>").into_bytes()));
                } else {
                    edits.push((n.close_start..n.close_start, builds_xml.as_bytes().to_vec()));
                }
            }
        }
        None if !builds_xml.is_empty() => {
            let at = tree.child(timing, NS_P, "tnLst").map(|l| tree.node(l).end).unwrap_or(tree.node(timing).open_end);
            edits.push((at..at, format!("<p:bldLst>{builds_xml}</p:bldLst>").into_bytes()));
        }
        None => {}
    }
}

fn result(op: &str, slide: usize, index: usize, changed: bool) -> Value {
    json!({ "op": op, "slide": slide, "index": index, "changed": changed })
}

fn check_index(t: &Timing, index: usize) -> Result<(), Error> {
    if index < t.effects.len() {
        Ok(())
    } else {
        Err(Error::NotFound(format!("animation {index} (the slide has {})", t.effects.len())))
    }
}

/// Shape `id` as an animation target: a top-level shape of the slide, and
/// whether it has text (which gets a build entry, as PowerPoint writes).
fn animation_target(t: &Timing, id: u32) -> Result<bool, Error> {
    let tree = &t.tree;
    let sp_tree = tree.path(tree.root, &[(NS_P, "cSld"), (NS_P, "spTree")]).ok_or_else(|| Error::NotFound("shape tree".into()))?;
    let shape = tree.node(sp_tree).children.iter().copied().find(|&c| crate::shape_id(tree, c) == Some(id)).ok_or_else(|| Error::NotFound(format!("shape {id} at the top level of the slide (shapes inside a group animate with their group)")))?;
    Ok(tree.node(shape).is(NS_P, "sp") && tree.child(shape, NS_P, "txBody").is_some())
}

fn new_effect(t: &Timing, tp: &Template, spid: u32, grp: u32, next: &mut u32) -> Result<Effect, Error> {
    let body = tp.body.replace("{spid}", &spid.to_string());
    let fill = if tp.fill.is_empty() { String::new() } else { format!(r#" fill="{}""#, tp.fill) };
    let xml = format!(
        r#"<p:par><p:cTn id="0" presetID="{}" presetClass="{}" presetSubtype="{}"{fill} grpId="{grp}" nodeType="clickEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst>{body}</p:cTn></p:par>"#,
        tp.preset_id, tp.preset_class, tp.preset_subtype
    );
    let xml = renumber(t, &xml, next)?;
    let (src, tree) = fragment(&t.root_tag, &t.root_end, &xml)?;
    let par = tree.node(tree.root).children[0];
    read_effect(&tree, &src, par).ok_or_else(|| Error::Xml("bad effect template".into()))
}

/// Seconds to milliseconds, checked.
fn seconds(v: Option<f64>, what: &str) -> Result<Option<f64>, Error> {
    match v {
        Some(s) if !(0.0..=86_400.0).contains(&s) => Err(Error::InvalidCommand(format!("{what} must be 0 to 86400 seconds"))),
        Some(s) => Ok(Some(s * 1000.0)),
        None => Ok(None),
    }
}

/// Adds effect `class`/`name` on shape `id` at `index` (default: last).
#[allow(clippy::too_many_arguments)]
pub fn add_animation_effect(doc: &mut Presentation, slide: usize, id: u32, class: &str, name: &str, start: Start, duration: Option<f64>, delay: Option<f64>, index: Option<usize>) -> Result<Value, Error> {
    let tp = template(class, name)?;
    let (duration, delay) = (seconds(duration, "duration")?, seconds(delay, "delay")?);
    if duration == Some(0.0) {
        return Err(Error::InvalidCommand("duration must be above 0".into()));
    }
    let t = read_timing(doc, slide)?;
    let has_text = animation_target(&t, id)?;
    let at = index.unwrap_or(t.effects.len());
    if at > t.effects.len() {
        return Err(Error::NotFound(format!("animation position {at} (the slide has {})", t.effects.len())));
    }
    // The next build group of the shape, counting existing build entries.
    let mut grp = t.effects.iter().filter(|e| e.spid == Some(id)).filter_map(|e| e.grp.map(|g| g + 1)).max().unwrap_or(0);
    if let Some(list) = t.timing.and_then(|tm| t.tree.child(tm, NS_P, "bldLst")) {
        for &b in &t.tree.node(list).children {
            let n = t.tree.node(b);
            if num(n.attr("spid")) == Some(id as f64) {
                grp = grp.max(num(n.attr("grpId")).map(|g| g as u32 + 1).unwrap_or(0));
            }
        }
    }
    let mut next = t.next_id.max(2);
    let mut e = new_effect(&t, tp, id, grp, &mut next)?;
    retime(&t, &mut e, start, delay.unwrap_or(0.0), duration)?;
    let mut effects = t.effects.clone();
    effects.insert(at, e);
    let builds = if has_text { vec![(id, grp)] } else { Vec::new() };
    let mut t = t;
    t.next_id = next;
    let changed = write(doc, t, effects, &builds)?;
    Ok(result("add_animation_effect", slide, at, changed))
}

pub fn remove_animation_effect(doc: &mut Presentation, slide: usize, index: usize) -> Result<Value, Error> {
    let t = read_timing(doc, slide)?;
    check_index(&t, index)?;
    let mut effects = t.effects.clone();
    effects.remove(index);
    let changed = write(doc, t, effects, &[])?;
    Ok(result("remove_animation_effect", slide, index, changed))
}

pub fn move_animation_effect(doc: &mut Presentation, slide: usize, index: usize, to: usize) -> Result<Value, Error> {
    let t = read_timing(doc, slide)?;
    check_index(&t, index)?;
    check_index(&t, to)?;
    let mut effects = t.effects.clone();
    let e = effects.remove(index);
    effects.insert(to, e);
    let changed = write(doc, t, effects, &[])?;
    Ok(result("move_animation_effect", slide, to, changed))
}

/// Replaces the effect at `index` with preset `class`/`name` on the same
/// shape, keeping its start, delay and build group.
pub fn replace_animation_effect(doc: &mut Presentation, slide: usize, index: usize, class: &str, name: &str) -> Result<Value, Error> {
    let tp = template(class, name)?;
    let t = read_timing(doc, slide)?;
    check_index(&t, index)?;
    let old = t.effects[index].clone();
    let spid = old.spid.ok_or_else(|| Error::Unsupported("the effect has no shape target".into()))?;
    let mut next = t.next_id;
    let mut e = new_effect(&t, tp, spid, old.grp.unwrap_or(0), &mut next)?;
    retime(&t, &mut e, old.start, old.delay, None)?;
    let mut effects = t.effects.clone();
    effects[index] = e;
    let mut t = t;
    t.next_id = next;
    let changed = write(doc, t, effects, &[])?;
    Ok(result("replace_animation_effect", slide, index, changed))
}

/// Changes when the effect at `index` starts, its delay and its duration
/// (seconds); fields left out stay.
pub fn set_animation_timing(doc: &mut Presentation, slide: usize, index: usize, start: Option<Start>, duration: Option<f64>, delay: Option<f64>) -> Result<Value, Error> {
    let (duration, delay) = (seconds(duration, "duration")?, seconds(delay, "delay")?);
    if duration == Some(0.0) {
        return Err(Error::InvalidCommand("duration must be above 0".into()));
    }
    if start.is_none() && duration.is_none() && delay.is_none() {
        return Err(Error::InvalidCommand("set at least one of start, duration and delay".into()));
    }
    let t = read_timing(doc, slide)?;
    check_index(&t, index)?;
    let mut effects = t.effects.clone();
    let e = &mut effects[index];
    let (s, d) = (start.unwrap_or(e.start), delay.unwrap_or(e.delay));
    retime(&t, e, s, d, duration)?;
    let changed = write(doc, t, effects, &[])?;
    Ok(result("set_animation_timing", slide, index, changed))
}
