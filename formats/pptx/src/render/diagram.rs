//! SmartArt layout: runs a diagram's layout definition (`dgm:layoutDef`)
//! over its data model and places the resulting shapes, as PowerPoint
//! does when it opens a SmartArt (it lays the diagram out from the data;
//! a saved drawing is only a cache).
//!
//! The definition is a program: layout nodes, `forEach` over the data
//! (children, siblings, descendants), `choose`/`if` on counts, depth and
//! variables, constraints (sizes, margins, font sizes, spacing as values or
//! multiples of other values) and an algorithm per node: `lin` (in a row or
//! column), `snake` (wrapping grid), `cycle` (around a circle), `hierRoot` /
//! `hierChild` (organisation charts), `composite` (children placed by their
//! constraints), `tx` (text), `sp` (space) and `conn` (connector arrows).
//! Positions are provisional ("smartArtLayout"); they are checked against
//! the layouts PowerPoint caches in files.

use std::collections::HashMap;

use kurbo::{Affine, Rect};

use crate::xml::{Tree, NS_A};

pub(super) const NS_DGM: &str = "http://schemas.openxmlformats.org/drawingml/2006/diagram";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum PtType {
    Doc,
    Node,
    Asst,
    ParTrans,
    SibTrans,
    Pres,
}

pub(super) struct Pt {
    #[allow(dead_code)]
    pub id: String,
    pub kind: PtType,
    /// The `dgm:pt` element in the data part.
    pub node: usize,
}

/// The data model: points and how they hang together.
pub(super) struct Model {
    pub pts: Vec<Pt>,
    /// Content children of a point, in order.
    children: HashMap<usize, Vec<usize>>,
    parent: HashMap<usize, usize>,
    par_trans: HashMap<usize, usize>,
    sib_trans: HashMap<usize, usize>,
    /// Presentation points by (layout node name, associated point).
    pres: HashMap<(String, usize), usize>,
    pub root: usize,
}

impl Model {
    pub fn read(tree: &Tree) -> Option<Model> {
        let pt_lst = tree.child(tree.root, NS_DGM, "ptLst")?;
        let mut pts = Vec::new();
        let mut by_id = HashMap::new();
        for p in tree.children_named(pt_lst, NS_DGM, "pt") {
            let n = tree.node(p);
            let kind = match n.attr("type").unwrap_or("node") {
                "doc" => PtType::Doc,
                "asst" => PtType::Asst,
                "parTrans" => PtType::ParTrans,
                "sibTrans" => PtType::SibTrans,
                "pres" => PtType::Pres,
                _ => PtType::Node,
            };
            let id = n.attr("modelId").unwrap_or_default().to_owned();
            by_id.insert(id.clone(), pts.len());
            pts.push(Pt { id, kind, node: p });
        }
        let root = pts.iter().position(|p| p.kind == PtType::Doc)?;
        let mut m = Model { pts, children: HashMap::new(), parent: HashMap::new(), par_trans: HashMap::new(), sib_trans: HashMap::new(), pres: HashMap::new(), root };
        let mut kids: HashMap<usize, Vec<(i64, usize)>> = HashMap::new();
        if let Some(cxn_lst) = tree.child(tree.root, NS_DGM, "cxnLst") {
            for c in tree.children_named(cxn_lst, NS_DGM, "cxn") {
                let n = tree.node(c);
                let (Some(&src), Some(&dst)) = (n.attr("srcId").and_then(|s| by_id.get(s)), n.attr("destId").and_then(|s| by_id.get(s))) else { continue };
                match n.attr("type").unwrap_or("parOf") {
                    "parOf" => {
                        let ord = n.attr("srcOrd").and_then(|v| v.parse().ok()).unwrap_or(0);
                        kids.entry(src).or_default().push((ord, dst));
                        m.parent.insert(dst, src);
                        if let Some(&t) = n.attr("parTransId").and_then(|s| by_id.get(s)) {
                            m.par_trans.insert(dst, t);
                        }
                        if let Some(&t) = n.attr("sibTransId").and_then(|s| by_id.get(s)) {
                            m.sib_trans.insert(dst, t);
                        }
                    }
                    "presOf" => {
                        let name = tree.child(m.pts[dst].node, NS_DGM, "prSet").and_then(|s| tree.node(s).attr("presName")).unwrap_or_default().to_owned();
                        m.pres.insert((name, src), dst);
                    }
                    _ => {}
                }
            }
        }
        // Presentation points name their layout node and point themselves.
        for (i, p) in m.pts.iter().enumerate() {
            if p.kind != PtType::Pres {
                continue;
            }
            let Some(ps) = tree.child(p.node, NS_DGM, "prSet") else { continue };
            let n = tree.node(ps);
            if let (Some(name), Some(&assoc)) = (n.attr("presName"), n.attr("presAssocID").and_then(|a| by_id.get(a))) {
                m.pres.entry((name.to_owned(), assoc)).or_insert(i);
            }
        }
        for (p, mut list) in kids {
            list.sort_by_key(|(o, _)| *o);
            m.children.insert(p, list.into_iter().map(|(_, c)| c).collect());
        }
        // Transitions belong to the parent of the node they lead to/from.
        let trans: Vec<(usize, usize)> = m.par_trans.iter().chain(m.sib_trans.iter()).map(|(&n, &t)| (n, t)).collect();
        for (node, t) in trans {
            if let Some(&p) = m.parent.get(&node) {
                m.parent.insert(t, p);
            }
        }
        Some(m)
    }

    fn kids(&self, p: usize) -> &[usize] {
        self.children.get(&p).map(Vec::as_slice).unwrap_or(&[])
    }

    /// The children of `p` with their transitions, in order:
    /// parTrans, node, sibTrans for each child. The last sibling
    /// transition is left out when `hide_last`.
    fn sequence(&self, p: usize, hide_last: bool) -> Vec<usize> {
        let kids = self.kids(p);
        let mut out = Vec::new();
        for (i, &c) in kids.iter().enumerate() {
            if let Some(&t) = self.par_trans.get(&c) {
                out.push(t);
            }
            out.push(c);
            if let Some(&t) = self.sib_trans.get(&c) {
                if !(hide_last && i + 1 == kids.len()) {
                    out.push(t);
                }
            }
        }
        out
    }

    fn depth(&self, p: usize) -> usize {
        let mut d = 0;
        let mut at = p;
        while let Some(&q) = self.parent.get(&at) {
            d += 1;
            at = q;
        }
        d
    }

    fn descendants(&self, p: usize, hide_last: bool, out: &mut Vec<usize>) {
        for c in self.sequence(p, hide_last) {
            out.push(c);
            if matches!(self.pts[c].kind, PtType::Node | PtType::Asst) {
                self.descendants(c, hide_last, out);
            }
        }
    }

    pub fn pres_point(&self, name: &str, assoc: usize) -> Option<usize> {
        self.pres.get(&(name.to_owned(), assoc)).copied()
    }

    fn axis(&self, ctx: usize, axis: &str, hide_last: bool) -> Vec<usize> {
        match axis {
            "self" | "" | "none" => vec![ctx],
            "ch" => self.sequence(ctx, hide_last),
            "des" => {
                let mut v = Vec::new();
                self.descendants(ctx, hide_last, &mut v);
                v
            }
            "desOrSelf" => {
                let mut v = vec![ctx];
                self.descendants(ctx, hide_last, &mut v);
                v
            }
            "par" => self.parent.get(&ctx).map(|&p| vec![p]).unwrap_or_default(),
            "ancst" | "ancstOrSelf" => {
                let mut v = if axis == "ancstOrSelf" { vec![ctx] } else { Vec::new() };
                let mut at = ctx;
                while let Some(&p) = self.parent.get(&at) {
                    v.push(p);
                    at = p;
                }
                v
            }
            "root" => vec![self.root],
            "followSib" | "precedSib" => {
                let Some(&p) = self.parent.get(&ctx) else { return Vec::new() };
                let seq = self.sequence(p, hide_last);
                let Some(i) = seq.iter().position(|&x| x == ctx) else { return Vec::new() };
                if axis == "followSib" {
                    seq[i + 1..].to_vec()
                } else {
                    seq[..i].to_vec()
                }
            }
            _ => Vec::new(),
        }
    }

    fn matches(&self, p: usize, types: &str) -> bool {
        let k = self.pts[p].kind;
        types.split_whitespace().any(|t| match t {
            "all" => true,
            "doc" => k == PtType::Doc,
            // Assistants are nodes too; `norm`/`nonAsst` exclude them.
            "node" => matches!(k, PtType::Node | PtType::Asst),
            "norm" => k == PtType::Node,
            "asst" | "nonNorm" => k == PtType::Asst,
            "nonAsst" => k == PtType::Node,
            "parTrans" => k == PtType::ParTrans,
            "sibTrans" => k == PtType::SibTrans,
            "pres" => k == PtType::Pres,
            _ => false,
        })
    }

    /// Points along `axis` from `ctx`: each space-separated step of `axis`
    /// goes from every point of the previous step, keeping points of the
    /// step's `pt_type`, from its `st` (1-based; negative from the end),
    /// `cnt` of them (0: all) every `step`.
    fn select(&self, ctx: usize, axis: &str, pt_type: &str, st: &str, cnt: &str, step: &str, hide_last: bool) -> Vec<usize> {
        let list = |s: &str| s.split_whitespace().map(str::to_owned).collect::<Vec<_>>();
        let (axes, types, sts, cnts, steps) = (list(axis), list(pt_type), list(st), list(cnt), list(step));
        let nth = |v: &Vec<String>, k: usize, d: &str| v.get(k).or(v.last()).cloned().unwrap_or_else(|| d.to_owned());
        let mut current = vec![ctx];
        for k in 0..axes.len().max(1) {
            let ax = nth(&axes, k, "self");
            let ty = nth(&types, k, "all");
            let s0: i64 = nth(&sts, k, "1").parse().unwrap_or(1);
            let c0: usize = nth(&cnts, k, "0").parse().unwrap_or(0);
            let p0: i64 = nth(&steps, k, "1").parse().unwrap_or(1);
            let mut next = Vec::new();
            for b in current {
                let found: Vec<usize> = self.axis(b, &ax, hide_last).into_iter().filter(|&p| self.matches(p, &ty)).collect();
                let n = found.len() as i64;
                let mut i = if s0 < 0 { n + s0 } else { s0 - 1 }.max(0);
                let step = if p0 == 0 { 1 } else { p0 };
                let mut taken = 0;
                while i >= 0 && i < n && (c0 == 0 || taken < c0) {
                    next.push(found[i as usize]);
                    taken += 1;
                    i += step;
                }
            }
            current = next;
        }
        current
    }
}

/// A constraint of a layout node (`dgm:constr`).
#[derive(Clone, Debug)]
struct Constr {
    ty: String,
    target: String,
    for_name: String,
    pt_type: String,
    ref_ty: String,
    ref_for: String,
    ref_for_name: String,
    ref_pt_type: String,
    op: String,
    fact: f64,
    val: f64,
    /// Whether `val` was given: `op="equ"` alone only asks for equal values.
    has_val: bool,
}

#[derive(Clone, Debug)]
struct Rule {
    ty: String,
    val: f64,
    fact: Option<f64>,
}

/// A laid-out node of the diagram.
#[derive(Clone, Debug, Default)]
pub(super) struct LNode {
    pub name: String,
    /// The data point it was made for.
    pub pt: usize,
    pub alg: String,
    pub params: HashMap<String, String>,
    /// Preset geometry; empty for none, `conn` for a connector arrow.
    pub shape: Option<String>,
    pub adj: Vec<(usize, f64)>,
    pub hide_geom: bool,
    pub shape_rot: f64,
    pub z_off: i32,
    /// Points whose text it shows.
    pub text: Vec<usize>,
    pub style_lbl: Option<String>,
    constrs: Vec<Constr>,
    rules: Vec<Rule>,
    vars: HashMap<String, String>,
    pub children: Vec<LNode>,
    /// Constraint values for this node (w, h, l, t, primFontSz, margins...).
    pub vals: HashMap<String, f64>,
    /// Box in the diagram, points.
    pub rect: Rect,
    /// Rotation of the shape in degrees (connectors along a circle).
    pub rot: f64,
    /// Among siblings made by the same layout node: position and count.
    pub index: usize,
    pub count: usize,
    /// Connector lines drawn for the whole diagram (organisation charts).
    pub lines: Vec<(kurbo::Point, kurbo::Point)>,
}

struct Builder<'a> {
    lt: &'a Tree,
    dt: &'a Tree,
    model: &'a Model,
    /// Named `forEach` elements, for `ref`.
    for_each: HashMap<String, usize>,
}

fn num(v: Option<&str>, d: f64) -> f64 {
    match v {
        Some("INF") => f64::INFINITY,
        Some("NaN") => f64::NAN,
        Some(s) => s.parse().unwrap_or(d),
        None => d,
    }
}

impl Builder<'_> {
    fn var(&self, stack: &[HashMap<String, String>], ctx: usize, node_name: &str, name: &str) -> Option<String> {
        // A data point's own layout variables come first.
        if let Some(pres) = self.model.pres_point(node_name, ctx) {
            let n = self.dt.path(self.model.pts[pres].node, &[(NS_DGM, "prSet"), (NS_DGM, "presLayoutVars")]);
            if let Some(v) = n.and_then(|l| self.dt.child(l, NS_DGM, name)).and_then(|v| self.dt.node(v).attr("val")) {
                return Some(v.to_owned());
            }
        }
        stack.iter().rev().find_map(|m| m.get(name).cloned())
    }

    fn condition(&self, el: usize, ctx: usize, stack: &[HashMap<String, String>], node_name: &str) -> bool {
        let n = self.lt.node(el);
        let a = |k: &str| n.attr(k).unwrap_or_default();
        let hide = n.attr("hideLastTrans") != Some("0");
        let value: Option<f64>;
        let mut text: Option<String> = None;
        match a("func") {
            "cnt" => value = Some(self.model.select(ctx, a("axis"), if a("ptType").is_empty() { "all" } else { a("ptType") }, n.attr("st").unwrap_or("1"), n.attr("cnt").unwrap_or("0"), n.attr("step").unwrap_or("1"), hide).len() as f64),
            "pos" | "revPos" | "posEven" | "posOdd" => {
                let sibs: Vec<usize> = self.model.parent.get(&ctx).map(|&p| self.model.kids(p).to_vec()).unwrap_or_else(|| vec![ctx]);
                let pos = sibs.iter().position(|&x| x == ctx).map(|i| i + 1).unwrap_or(1) as f64;
                value = Some(match a("func") {
                    "revPos" => sibs.len() as f64 - pos + 1.0,
                    "posEven" => ((pos as i64) % 2 == 0) as i64 as f64,
                    "posOdd" => ((pos as i64) % 2 == 1) as i64 as f64,
                    _ => pos,
                });
            }
            "depth" => value = Some(self.model.depth(ctx) as f64),
            "maxDepth" => {
                // The deepest of the points the axis selects (depth from
                // the document), else of the context's descendants.
                if !a("axis").is_empty() {
                    let pts = self.model.select(ctx, a("axis"), if a("ptType").is_empty() { "all" } else { a("ptType") }, n.attr("st").unwrap_or("1"), n.attr("cnt").unwrap_or("0"), n.attr("step").unwrap_or("1"), hide);
                    value = Some(pts.iter().filter(|&&d| matches!(self.model.pts[d].kind, PtType::Node | PtType::Asst)).map(|&d| self.model.depth(d)).max().unwrap_or(0) as f64);
                } else {
                    let mut des = Vec::new();
                    self.model.descendants(ctx, true, &mut des);
                    let d0 = self.model.depth(ctx);
                    value = Some(des.iter().filter(|&&d| matches!(self.model.pts[d].kind, PtType::Node | PtType::Asst)).map(|&d| self.model.depth(d) - d0).max().unwrap_or(0) as f64);
                }
            }
            "var" => {
                let v = self.var(stack, ctx, node_name, a("arg")).unwrap_or_else(|| match a("arg") {
                    "dir" => "norm".into(),
                    "hierBranch" => "std".into(),
                    _ => "none".into(),
                });
                value = v.parse().ok();
                text = Some(v);
            }
            _ => return false,
        }
        let want = a("val");
        let (x, y) = (value.unwrap_or(f64::NAN), want.parse::<f64>().ok());
        match (a("op"), &text, y) {
            ("equ", Some(t), _) if value.is_none() || y.is_none() => t == want,
            ("neq", Some(t), _) if value.is_none() || y.is_none() => t != want,
            ("equ", _, Some(y)) => x == y,
            ("neq", _, Some(y)) => x != y,
            ("gt", _, Some(y)) => x > y,
            ("lt", _, Some(y)) => x < y,
            ("gte", _, Some(y)) => x >= y,
            ("lte", _, Some(y)) => x <= y,
            _ => false,
        }
    }

    /// Processes the content of layout element `el` for data point `ctx`
    /// into `node`.
    fn content(&self, el: usize, ctx: usize, node: &mut LNode, stack: &mut Vec<HashMap<String, String>>) {
        for &c in &self.lt.node(el).children {
            let n = self.lt.node(c);
            if n.ns.as_deref() != Some(NS_DGM) {
                continue;
            }
            match n.local.as_str() {
                "layoutNode" => {
                    let mut child = LNode { name: n.attr("name").unwrap_or_default().to_owned(), pt: ctx, style_lbl: n.attr("styleLbl").map(str::to_owned), ..Default::default() };
                    stack.push(HashMap::new());
                    self.content(c, ctx, &mut child, stack);
                    child.vars = stack.pop().unwrap_or_default();
                    if child.style_lbl.is_none() {
                        child.style_lbl = node.style_lbl.clone();
                    }
                    node.children.push(child);
                }
                "varLst" => {
                    for &v in &n.children {
                        let vn = self.lt.node(v);
                        if let Some(val) = vn.attr("val") {
                            stack.last_mut().unwrap().insert(vn.local.clone(), val.to_owned());
                        }
                    }
                }
                "alg" => {
                    node.alg = n.attr("type").unwrap_or_default().to_owned();
                    for p in self.lt.children_named(c, NS_DGM, "param") {
                        let pn = self.lt.node(p);
                        if let (Some(t), Some(v)) = (pn.attr("type"), pn.attr("val")) {
                            node.params.insert(t.to_owned(), v.to_owned());
                        }
                    }
                }
                "shape" => {
                    node.shape = Some(n.attr("type").unwrap_or_default().to_owned());
                    node.hide_geom = n.attr("hideGeom") == Some("1") || n.attr("hideGeom") == Some("true");
                    node.shape_rot = num(n.attr("rot"), 0.0);
                    node.z_off = num(n.attr("zOrderOff"), 0.0) as i32;
                    node.adj = self.lt.child(c, NS_DGM, "adjLst").map(|l| self.lt.children_named(l, NS_DGM, "adj").map(|a| (num(self.lt.node(a).attr("idx"), 1.0) as usize, num(self.lt.node(a).attr("val"), 0.0))).collect()).unwrap_or_default();
                }
                "presOf" => {
                    let axis = n.attr("axis").unwrap_or("");
                    node.text = if axis.is_empty() {
                        Vec::new()
                    } else {
                        self.model.select(ctx, axis, n.attr("ptType").unwrap_or("all"), n.attr("st").unwrap_or("1"), n.attr("cnt").unwrap_or("0"), n.attr("step").unwrap_or("1"), true)
                    };
                }
                "constrLst" => {
                    for k in self.lt.children_named(c, NS_DGM, "constr") {
                        let cn = self.lt.node(k);
                        let a = |x: &str, d: &str| cn.attr(x).unwrap_or(d).to_owned();
                        node.constrs.push(Constr {
                            ty: a("type", "none"),
                            target: a("for", "self"),
                            for_name: a("forName", ""),
                            pt_type: a("ptType", "all"),
                            ref_ty: a("refType", "none"),
                            ref_for: a("refFor", "self"),
                            ref_for_name: a("refForName", ""),
                            ref_pt_type: a("refPtType", "all"),
                            op: a("op", "none"),
                            fact: num(cn.attr("fact"), 1.0),
                            val: num(cn.attr("val"), 0.0),
                            has_val: cn.attr("val").is_some(),
                        });
                    }
                }
                "ruleLst" => {
                    for k in self.lt.children_named(c, NS_DGM, "rule") {
                        let rn = self.lt.node(k);
                        node.rules.push(Rule { ty: rn.attr("type").unwrap_or_default().to_owned(), val: num(rn.attr("val"), f64::NAN), fact: rn.attr("fact").map(|f| num(Some(f), f64::NAN)) });
                    }
                }
                "forEach" => {
                    let body = n.attr("ref").and_then(|r| self.for_each.get(r).copied()).unwrap_or(c);
                    let bn = self.lt.node(body);
                    let hide = bn.attr("hideLastTrans") != Some("0");
                    let pts = self.model.select(ctx, bn.attr("axis").unwrap_or("self"), bn.attr("ptType").unwrap_or("all"), bn.attr("st").unwrap_or("1"), bn.attr("cnt").unwrap_or("0"), bn.attr("step").unwrap_or("1"), hide);
                    for p in pts {
                        self.content(body, p, node, stack);
                    }
                }
                "choose" => {
                    let name = node.name.clone();
                    let branch = self.lt.children_named(c, NS_DGM, "if").find(|&i| self.condition(i, ctx, stack, &name)).or_else(|| self.lt.child(c, NS_DGM, "else"));
                    if let Some(b) = branch {
                        self.content(b, ctx, node, stack);
                    }
                }
                _ => {}
            }
        }
    }
}

/// Builds the diagram's node tree from layout definition `lt` and data `dt`.
pub(super) fn build(lt: &Tree, dt: &Tree, model: &Model) -> Option<LNode> {
    let def = lt.child(lt.root, NS_DGM, "layoutNode")?;
    let mut for_each = HashMap::new();
    for (i, n) in lt.nodes.iter().enumerate() {
        if n.ns.as_deref() == Some(NS_DGM) && n.local == "forEach" {
            if let Some(name) = n.attr("name") {
                for_each.insert(name.to_owned(), i);
            }
        }
    }
    let b = Builder { lt, dt, model, for_each };
    let mut stack = vec![HashMap::new(), HashMap::new()];
    let mut root = LNode { name: lt.node(def).attr("name").unwrap_or_default().to_owned(), pt: model.root, style_lbl: lt.node(def).attr("styleLbl").map(str::to_owned), ..Default::default() };
    b.content(def, model.root, &mut root, &mut stack);
    root.vars = stack.pop().unwrap_or_default();
    number(&mut root);
    Some(root)
}

/// Index and count of each node among siblings of the same name.
fn number(n: &mut LNode) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for c in &n.children {
        *counts.entry(c.name.clone()).or_default() += 1;
    }
    let mut seen: HashMap<String, usize> = HashMap::new();
    for c in n.children.iter_mut() {
        let k = seen.entry(c.name.clone()).or_default();
        c.index = *k;
        c.count = counts[&c.name];
        *k += 1;
        number(c);
    }
}

fn matches_name(n: &LNode, name: &str) -> bool {
    name.is_empty() || n.name == name
}

impl LNode {
    fn get(&self, k: &str) -> Option<f64> {
        self.vals.get(k).copied().filter(|v| v.is_finite())
    }

    /// Default value of `k` for this node when no constraint set it.
    fn default_of(&self, k: &str) -> f64 {
        match k {
            "w" => self.rect.width(),
            "h" => self.rect.height(),
            "l" | "t" => 0.0,
            "r" => self.get("l").unwrap_or(0.0) + self.get("w").unwrap_or(self.rect.width()),
            "b" => self.get("t").unwrap_or(0.0) + self.get("h").unwrap_or(self.rect.height()),
            "ctrX" => self.get("l").unwrap_or(0.0) + self.get("w").unwrap_or(self.rect.width()) / 2.0,
            "ctrY" => self.get("t").unwrap_or(0.0) + self.get("h").unwrap_or(self.rect.height()) / 2.0,
            "primFontSz" => 65.0,
            "connDist" => 0.0,
            _ => 0.0,
        }
    }

    fn value(&self, k: &str) -> f64 {
        self.get(k).unwrap_or_else(|| self.default_of(k))
    }
}

/// Indices (paths) of nodes a constraint applies to.
fn targets(n: &LNode, model: &Model, target: &str, name: &str, pt_type: &str) -> Vec<Vec<usize>> {
    let ok = |c: &LNode| matches_name(c, name) && (pt_type == "all" || model.matches(c.pt, pt_type));
    match target {
        "ch" => n.children.iter().enumerate().filter(|(_, c)| ok(c)).map(|(i, _)| vec![i]).collect(),
        "des" => {
            let mut out = Vec::new();
            fn walk(n: &LNode, path: &mut Vec<usize>, out: &mut Vec<Vec<usize>>, ok: &dyn Fn(&LNode) -> bool) {
                for (i, c) in n.children.iter().enumerate() {
                    path.push(i);
                    if ok(c) {
                        out.push(path.clone());
                    }
                    walk(c, path, out, ok);
                    path.pop();
                }
            }
            walk(n, &mut Vec::new(), &mut out, &ok);
            out
        }
        _ => vec![Vec::new()],
    }
}

fn at_mut<'a>(n: &'a mut LNode, path: &[usize]) -> &'a mut LNode {
    path.iter().fold(n, |m, &i| &mut m.children[i])
}

fn at<'a>(n: &'a LNode, path: &[usize]) -> &'a LNode {
    path.iter().fold(n, |m, &i| &m.children[i])
}

/// Applies node `n`'s constraints to itself and the nodes below it.
fn apply_constraints(n: &mut LNode, model: &Model) {
    let constrs = n.constrs.clone();
    // Nodes one "equal font size" constraint names share a size: they get
    // a group number unique to this node and constraint.
    static GROUPS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(1);
    for c in &constrs {
        if c.ty == "primFontSz" && c.op == "equ" {
            let g = GROUPS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) as f64;
            for path in targets(n, model, &c.target, &c.for_name, &c.pt_type) {
                at_mut(n, &path).vals.insert("__eq".into(), g);
            }
        }
    }
    for c in &constrs {
        // "Equal" with nothing to equal to sets nothing.
        if c.ref_ty == "none" && !c.has_val && c.op == "equ" {
            continue;
        }
        let value = if c.ref_ty != "none" {
            let refs = targets(n, model, &c.ref_for, &c.ref_for_name, &c.ref_pt_type);
            let Some(path) = refs.first() else { continue };
            let src = at(n, path);
            src.value(&c.ref_ty) * if c.fact.is_finite() { c.fact } else { 1.0 }
        } else {
            c.val
        };
        if !value.is_finite() && c.ty != "h" && c.ty != "w" {
            continue;
        }
        for path in targets(n, model, &c.target, &c.for_name, &c.pt_type) {
            let t = at_mut(n, &path);
            // Margins in font sizes follow the font as it shrinks.
            if (c.ref_ty == "primFontSz" && c.ty.ends_with("Marg")) || (c.ref_ty == "connDist" && c.ty.ends_with("Pad")) {
                t.vals.insert(format!("__f_{}", c.ty), if c.fact.is_finite() { c.fact } else { 1.0 });
            }
            match c.op.as_str() {
                "lte" => {
                    let cur = t.get(&c.ty);
                    if cur.map(|v| v > value).unwrap_or(false) {
                        t.vals.insert(c.ty.clone(), value);
                    }
                }
                "gte" => {
                    let cur = t.get(&c.ty);
                    if cur.map(|v| v < value).unwrap_or(false) {
                        t.vals.insert(c.ty.clone(), value);
                    }
                }
                _ => {
                    t.vals.insert(c.ty.clone(), value);
                }
            }
        }
    }
}

/// Lays out `n` in `rect` (its own constraints already applied by its
/// parent), then its children.
pub(super) fn layout(n: &mut LNode, model: &Model, rect: Rect) {
    // An organisation chart is placed as a whole, then each box inside.
    if n.vals.get("__orgroot").is_none() && contains_alg(n, "hierRoot") {
        n.vals.insert("__orgroot".into(), 1.0);
        n.rect = rect;
        n.vals.insert("w".into(), rect.width());
        n.vals.insert("h".into(), rect.height());
        apply_constraints(n, model);
        if org_chart(n, model, rect) {
            lay_boxes(n, model);
            n.vals.remove("__orgroot");
            return;
        }
        n.vals.remove("__orgroot");
    }
    // A composite with an aspect ratio (`ar`, width over height) takes the
    // largest such box centred in its room.
    let rect = match n.params.get("ar").and_then(|v| v.parse::<f64>().ok()).filter(|a| *a > 0.0 && n.alg == "composite") {
        Some(ar) => {
            let (w, h) = if rect.width() / rect.height().max(1e-9) > ar { (rect.height() * ar, rect.height()) } else { (rect.width(), rect.width() / ar) };
            let c = rect.center();
            Rect::new(c.x - w / 2.0, c.y - h / 2.0, c.x + w / 2.0, c.y + h / 2.0)
        }
        None => rect,
    };
    n.rect = rect;
    // Own sizes known: constraints may refer to them.
    n.vals.insert("w".into(), rect.width());
    n.vals.insert("h".into(), rect.height());
    apply_constraints(n, model);
    // Children's own constraints on themselves (e.g. h = 0.6 w), and the
    // pads and margins they define in other sizes.
    for c in n.children.iter_mut() {
        for k in c.constrs.iter().filter(|k| k.target == "self" && ((k.ref_ty == "connDist" && k.ty.ends_with("Pad")) || (k.ref_ty == "primFontSz" && k.ty.ends_with("Marg")))) {
            c.vals.insert(format!("__f_{}", k.ty), if k.fact.is_finite() { k.fact } else { 1.0 });
        }
        let own: Vec<Constr> = c.constrs.iter().filter(|k| k.target == "self" && matches!(k.ty.as_str(), "w" | "h") && k.ref_for == "self").cloned().collect();
        for k in own {
            // A constant of its own is a default the parent's constraints
            // override; a size from its other size applies on top.
            if k.ref_ty == "none" && (c.get(&k.ty).is_some() || (!k.has_val && k.op == "equ")) {
                continue;
            }
            let v = if k.ref_ty != "none" { c.value(&k.ref_ty) * if k.fact.is_finite() { k.fact } else { 1.0 } } else { k.val };
            if v.is_finite() && !(k.op == "lte" && c.get(&k.ty).is_some_and(|x| x <= v)) && !(k.op == "gte" && c.get(&k.ty).is_some_and(|x| x >= v)) {
                c.vals.insert(k.ty.clone(), v);
            }
        }
    }
    match n.alg.as_str() {
        "lin" => lin(n),
        "snake" => snake(n),
        "cycle" => cycle(n),
        "hierRoot" => hier_root(n),
        "hierChild" => hier_child(n),
        _ => composite(n),
    }
    let boxes: Vec<Rect> = n.children.iter().map(|c| c.rect).collect();
    for (c, r) in n.children.iter_mut().zip(boxes) {
        layout(c, model, r);
    }
}

fn contains_alg(n: &LNode, alg: &str) -> bool {
    n.alg == alg || n.children.iter().any(|c| contains_alg(c, alg))
}

/// Lays out the inside of each placed organisation chart box.
fn lay_boxes(n: &mut LNode, model: &Model) {
    for c in n.children.iter_mut() {
        if c.vals.remove("__org").is_some() {
            let r = c.rect;
            layout(c, model, r);
            c.vals.insert("__org".into(), 1.0);
        } else {
            lay_boxes(c, model);
        }
    }
}

/// Size along `dim` (`w` or `h`) a node needs when no constraint gives it:
/// a row's children add up along it, others take the largest child;
/// nothing for a node with no content.
fn natural(n: &LNode, dim: &str) -> f64 {
    if let Some(v) = n.get(dim) {
        return v * n.vals.get(if dim == "w" { "__gw" } else { "__gh" }).copied().unwrap_or(1.0);
    }
    let along = match n.params.get("linDir").map(String::as_str) {
        Some("fromT" | "fromB") => "h",
        _ => "w",
    };
    if n.alg == "lin" && dim == along {
        n.children.iter().map(|c| natural(c, dim)).sum()
    } else {
        n.children.iter().map(|c| natural(c, dim)).fold(0.0, f64::max)
    }
}

/// A child's size in a row or grid: its constraints, else what its content
/// needs.
fn flow_size_of(c: &LNode) -> (f64, f64) {
    (natural(c, "w").max(0.0), natural(c, "h").max(0.0))
}

fn size_of(c: &LNode, parent: Rect) -> (f64, f64) {
    let w = c.get("w").unwrap_or(parent.width()) * c.vals.get("__gw").copied().unwrap_or(1.0);
    let h = c.get("h").unwrap_or(parent.height()) * c.vals.get("__gh").copied().unwrap_or(1.0);
    (w.max(0.0), h.max(0.0))
}

/// Children placed by their l/t/w/h (r, b, ctrX, ctrY) values.
fn composite(n: &mut LNode) {
    let r = n.rect;
    for c in n.children.iter_mut() {
        let w = c.get("w").or_else(|| Some(c.get("r")? - c.get("l")?)).unwrap_or(r.width());
        let h = c.get("h").or_else(|| Some(c.get("b")? - c.get("t")?)).unwrap_or(r.height());
        let l = c.get("l").or_else(|| c.get("ctrX").map(|x| x - w / 2.0)).or_else(|| c.get("r").map(|x| x - w)).unwrap_or(0.0);
        let t = c.get("t").or_else(|| c.get("ctrY").map(|y| y - h / 2.0)).or_else(|| c.get("b").map(|y| y - h)).unwrap_or(0.0);
        c.rect = Rect::new(r.x0 + l, r.y0 + t, r.x0 + l + w, r.y0 + t + h);
    }
    // A composite keeps its children's aspect within its box.
    let Some(bounds) = n.children.iter().map(|c| c.rect).reduce(|a, b| a.union(b)) else { return };
    if bounds.width() > r.width() * 1.001 || bounds.height() > r.height() * 1.001 {
        let s = (r.width() / bounds.width()).min(r.height() / bounds.height());
        let t = Affine::translate((r.center().x, r.center().y)) * Affine::scale(s) * Affine::translate((-bounds.center().x, -bounds.center().y));
        for c in n.children.iter_mut() {
            c.rect = t.transform_rect_bbox(c.rect);
        }
    }
}

/// A node's own size rule for `dim` in terms of its other size (`h` = 0.6
/// `w`), as (fact).
fn self_ratio(c: &LNode, dim: &str, other: &str) -> Option<f64> {
    c.constrs.iter().rev().find(|k| k.target == "self" && k.ty == dim && k.ref_for == "self" && k.ref_ty == other).map(|k| if k.fact.is_finite() { k.fact } else { 1.0 })
}

/// Children in a row (or column): their lengths along the flow scale
/// together to fill it exactly (measured against PowerPoint's cached
/// layouts); across it, a size defined by the child's own length follows the
/// scaled length, other sizes stay, all within the room. Connectors span the
/// gap between their neighbours less their pads.
fn lin(n: &mut LNode) {
    let r = n.rect;
    let dir = n.params.get("linDir").map(String::as_str).unwrap_or("fromL");
    let vertical = matches!(dir, "fromT" | "fromB");
    let gap = n.get("sp").unwrap_or(0.0);
    let sizes: Vec<(f64, f64)> = n.children.iter().map(flow_size_of).collect();
    if sizes.is_empty() {
        return;
    }
    let (along_dim, across_dim) = if vertical { ("h", "w") } else { ("w", "h") };
    let along: f64 = sizes.iter().map(|s| if vertical { s.1 } else { s.0 }).sum::<f64>() + gap * (sizes.len() - 1) as f64;
    let (room_along, room_across) = if vertical { (r.height(), r.width()) } else { (r.width(), r.height()) };
    let s = room_along / along.max(1e-9);
    let mut pos = 0.0;
    let order: Vec<usize> = if matches!(dir, "fromR" | "fromB") { (0..sizes.len()).rev().collect() } else { (0..sizes.len()).collect() };
    let align = n.params.get(if vertical { "nodeHorzAlign" } else { "nodeVertAlign" }).cloned().unwrap_or_default();
    for i in order {
        let c = &mut n.children[i];
        let len = (if vertical { sizes[i].1 } else { sizes[i].0 }) * s;
        // Growth from text fitting applies to a size its own rule sets.
        let grow = c.vals.get(if across_dim == "w" { "__gw" } else { "__gh" }).copied().unwrap_or(1.0);
        let across = match self_ratio(c, across_dim, along_dim) {
            Some(f) => len * f * grow,
            None => if vertical { sizes[i].0 } else { sizes[i].1 },
        }
        .min(room_across);
        let off = match align.as_str() {
            "l" | "t" => 0.0,
            "r" | "b" => room_across - across,
            _ => (room_across - across) / 2.0,
        };
        c.rect = if vertical { Rect::new(r.x0 + off, r.y0 + pos, r.x0 + off + across, r.y0 + pos + len) } else { Rect::new(r.x0 + pos, r.y0 + off, r.x0 + pos + len, r.y0 + off + across) };
        // A size defined by the across size follows it (e.g. w = 1.8 h).
        pos += len + gap * s;
        if c.shape.as_deref() == Some("conn") || c.alg == "conn" {
            c.rot = match dir {
                "fromR" => 180.0,
                "fromT" => 90.0,
                "fromB" => 270.0,
                _ => 0.0,
            };
        }
    }
    // Connectors: from the previous node's end to the next one's start,
    // less their pads, as long as that and as thick as their size.
    let is_conn = |c: &LNode| c.shape.as_deref() == Some("conn") || c.alg == "conn";
    for i in 0..n.children.len() {
        if !is_conn(&n.children[i]) {
            continue;
        }
        let prev = (0..i).rev().find(|&j| !is_conn(&n.children[j]) && n.children[j].alg != "sp");
        let next = (i + 1..n.children.len()).find(|&j| !is_conn(&n.children[j]) && n.children[j].alg != "sp");
        let slot = n.children[i].rect;
        let (a, b) = match (prev, next) {
            (Some(p), Some(q)) => {
                let (pr, qr) = (n.children[p].rect, n.children[q].rect);
                if vertical { (pr.y1.min(qr.y1), qr.y0.max(pr.y0)) } else { (pr.x1.min(qr.x1), qr.x0.max(pr.x0)) }
            }
            _ => if vertical { (slot.y0, slot.y1) } else { (slot.x0, slot.x1) },
        };
        let (a, b) = (a.min(b), a.max(b));
        let dist = b - a;
        let c = &mut n.children[i];
        let pad = |k: &str| c.vals.get(&format!("__f_{k}")).map(|f| f * dist).or_else(|| c.get(k)).unwrap_or(0.0);
        let (bp, ep) = (pad("begPad"), pad("endPad"));
        let (bp, ep) = if matches!(dir, "fromR" | "fromB") { (ep, bp) } else { (bp, ep) };
        let thick = if vertical { slot.width() } else { slot.height() };
        let (s0, s1) = (a + bp, (b - ep).max(a + bp));
        c.rect = if vertical {
            let cx = slot.center().x;
            Rect::new(cx - thick / 2.0, s0, cx + thick / 2.0, s1)
        } else {
            let cy = slot.center().y;
            Rect::new(s0, cy - thick / 2.0, s1, cy + thick / 2.0)
        };
        // Drawn as a right arrow turned along the flow: its box is the
        // unturned shape (length across the turn for vertical flows).
        if vertical {
            let m = c.rect.center();
            let (l, t) = (c.rect.height(), c.rect.width());
            c.rect = Rect::new(m.x - l / 2.0, m.y - t / 2.0, m.x + l / 2.0, m.y + t / 2.0);
        }
    }
}

/// Children in a wrapping grid, with as many columns as gives them the
/// largest size.
fn snake(n: &mut LNode) {
    let r = n.rect;
    let items: Vec<usize> = (0..n.children.len()).filter(|&i| n.children[i].alg != "sp" || n.children[i].shape.as_deref().is_some_and(|s| !s.is_empty())).collect();
    if items.is_empty() {
        return;
    }
    let (w, h) = size_of(&n.children[items[0]], r);
    let gap = n.children.iter().find(|c| c.alg == "sp").and_then(|c| c.get("w")).or_else(|| n.get("sp")).unwrap_or(w * 0.1);
    let count = items.len();
    let mut best = (0.0, 1);
    for cols in 1..=count {
        let rows = count.div_ceil(cols);
        let need_w = cols as f64 * w + (cols - 1) as f64 * gap;
        let need_h = rows as f64 * h + (rows - 1) as f64 * gap;
        let s = (r.width() / need_w).min(r.height() / need_h);
        if s > best.0 + 1e-9 {
            best = (s, cols);
        }
    }
    let (s, cols) = best;
    let rows = count.div_ceil(cols);
    let (cw, ch, g) = (w * s, h * s, gap * s);
    let total_h = rows as f64 * ch + (rows - 1) as f64 * g;
    let y0 = r.y0 + (r.height() - total_h) / 2.0;
    for (k, &i) in items.iter().enumerate() {
        let (row, col) = (k / cols, k % cols);
        let in_row = if row + 1 == rows { count - row * cols } else { cols };
        let row_w = in_row as f64 * cw + (in_row - 1) as f64 * g;
        let x0 = r.x0 + (r.width() - row_w) / 2.0;
        let x = x0 + col as f64 * (cw + g);
        let y = y0 + row as f64 * (ch + g);
        n.children[i].rect = Rect::new(x, y, x + cw, y + ch);
    }
    for i in 0..n.children.len() {
        if !items.contains(&i) {
            n.children[i].rect = Rect::new(r.x0, r.y0, r.x0, r.y0);
        }
    }
}

/// Nodes around a circle from `stAng` (0 at the top, clockwise) over
/// `spanAng`, far enough apart for their size plus the spacing (a spacing
/// node's width, or `sibSp`) between neighbours; the whole ring then scales
/// into the room. Connectors sit between neighbours, along the circle.
fn cycle(n: &mut LNode) {
    let r = n.rect;
    let st = n.params.get("stAng").and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
    let span = n.params.get("spanAng").and_then(|v| v.parse::<f64>().ok()).unwrap_or(360.0);
    let center_first = n.params.get("ctrShpMap").map(String::as_str) == Some("fNode");
    let is_conn = |c: &LNode| c.shape.as_deref() == Some("conn") || c.alg == "conn";
    let nodes: Vec<usize> = (0..n.children.len()).filter(|&i| !is_conn(&n.children[i]) && n.children[i].alg != "sp").collect();
    let conns: Vec<usize> = (0..n.children.len()).filter(|&i| is_conn(&n.children[i])).collect();
    let spacing = n.children.iter().find(|c| c.alg == "sp").and_then(|c| c.get("w")).or_else(|| n.get("sibSp")).unwrap_or(0.0);
    let ring: Vec<usize> = if center_first { nodes.iter().copied().skip(1).collect() } else { nodes.clone() };
    let k = ring.len();
    let (w, h) = nodes.first().map(|&i| size_of(&n.children[i], r)).unwrap_or((0.0, 0.0));
    // Neighbours' centres are a node plus the spacing apart.
    let chord = w.max(h) + spacing;
    let full = (span.abs() - 360.0).abs() < 1e-6;
    let step = if full { span / k.max(1) as f64 } else { span / (k as f64 - 1.0).max(1.0) };
    let radius = if k < 2 { 0.0 } else { chord / (2.0 * (step.abs().to_radians() / 2.0).sin().max(1e-6)) };
    let radius = if center_first { radius.max(w.max(h) + spacing) } else { radius };
    let s = (r.width() / (2.0 * radius + w).max(1e-9)).min(r.height() / (2.0 * radius + h).max(1e-9)).min(1.0);
    let (w, h, radius) = (w * s, h * s, radius * s);
    let c = r.center();
    let mut centers = Vec::new();
    for (j, &i) in ring.iter().enumerate() {
        let a = (st + step * j as f64 - 90.0).to_radians();
        let p = (c.x + radius * a.cos(), c.y + radius * a.sin());
        centers.push((p, st + step * j as f64));
        n.children[i].rect = Rect::new(p.0 - w / 2.0, p.1 - h / 2.0, p.0 + w / 2.0, p.1 + h / 2.0);
    }
    if center_first {
        if let Some(&i) = nodes.first() {
            n.children[i].rect = Rect::new(c.x - w / 2.0, c.y - h / 2.0, c.x + w / 2.0, c.y + h / 2.0);
        }
    }
    for i in 0..n.children.len() {
        if n.children[i].alg == "sp" {
            n.children[i].rect = Rect::new(c.x, c.y, c.x, c.y);
        }
    }
    // Connector j between ring nodes j and j+1, halfway round, tangent.
    for (j, &i) in conns.iter().enumerate() {
        if centers.len() < 2 || (j + 1 >= centers.len() && !full) {
            n.children[i].rect = Rect::new(c.x, c.y, c.x, c.y);
            continue;
        }
        let a_deg = centers[j % centers.len()].1 + step / 2.0;
        let a = (a_deg - 90.0).to_radians();
        let m = (c.x + radius * a.cos(), c.y + radius * a.sin());
        let cw = n.children[i].get("w").map(|x| x * s).unwrap_or(w * 0.3);
        let ch = n.children[i].get("h").map(|x| x * s).unwrap_or(cw * 0.6);
        n.children[i].rect = Rect::new(m.0 - cw / 2.0, m.1 - ch / 2.0, m.0 + cw / 2.0, m.1 + ch / 2.0);
        n.children[i].rot = a_deg + if step >= 0.0 { 0.0 } else { 180.0 };
    }
}

/// Organisation charts (`hierRoot`/`hierChild`) are laid out as a whole by
/// `org_chart`; here their containers just keep their room.
fn hier_root(_: &mut LNode) {}

fn hier_child(_: &mut LNode) {}

/// One box of an organisation chart: the path of its `hierRoot` node.
struct OrgItem {
    path: Vec<usize>,
    kids: Vec<usize>,
    assistants: Vec<usize>,
}

/// Lays out an organisation chart: equal boxes in the definition's aspect
/// ratio, each parent centred over its children, assistants on their own
/// row beside the parent's line, the whole scaled into `frame`. Connector
/// lines go to `lines` (pairs of points).
fn org_chart(root: &mut LNode, model: &Model, frame: Rect) -> bool {
    let mut roots = Vec::new();
    fn find(n: &LNode, path: &mut Vec<usize>, out: &mut Vec<(Vec<usize>, usize)>) {
        for (i, c) in n.children.iter().enumerate() {
            path.push(i);
            if c.alg == "hierRoot" {
                out.push((path.clone(), c.pt));
            }
            find(c, path, out);
            path.pop();
        }
    }
    find(root, &mut Vec::new(), &mut roots);
    if roots.is_empty() {
        return false;
    }
    let by_pt: HashMap<usize, Vec<usize>> = roots.iter().map(|(p, pt)| (*pt, p.clone())).collect();
    let items: HashMap<usize, OrgItem> = by_pt
        .iter()
        .map(|(&pt, path)| {
            let kids: Vec<usize> = model.kids(pt).iter().copied().filter(|k| model.pts[*k].kind == PtType::Node && by_pt.contains_key(k)).collect();
            let assistants: Vec<usize> = model.kids(pt).iter().copied().filter(|k| model.pts[*k].kind == PtType::Asst && by_pt.contains_key(k)).collect();
            (pt, OrgItem { path: path.clone(), kids, assistants })
        })
        .collect();
    let tops: Vec<usize> = model.kids(model.root).iter().copied().filter(|k| items.contains_key(k)).collect();
    // Box aspect from the definition (its first sized box), else 1:2.
    let aspect = roots.iter().find_map(|(p, _)| {
        let n = at(root, p);
        let b = n.children.iter().find(|c| c.alg != "hierChild" && c.alg != "hierRoot")?;
        let (w, h) = (b.get("w")?, b.get("h")?);
        (w > 1.0 && h > 1.0).then_some(h / w)
    }).unwrap_or(0.5);
    // In box widths: sibling gap, level gap (in box heights), assistant row.
    let (gap, level) = (0.2, 0.8);
    fn width(items: &HashMap<usize, OrgItem>, pt: usize, gap: f64) -> f64 {
        let it = &items[&pt];
        let kids: f64 = it.kids.iter().map(|&k| width(items, k, gap)).sum::<f64>() + gap * it.kids.len().saturating_sub(1) as f64;
        let assist = if it.assistants.is_empty() { 0.0 } else { 2.0 + gap * 2.0 };
        1.0f64.max(kids).max(assist)
    }
    fn height(items: &HashMap<usize, OrgItem>, pt: usize, aspect: f64, level: f64) -> f64 {
        let it = &items[&pt];
        let rows = if it.assistants.is_empty() { 0.0 } else { aspect * (1.0 + level) };
        let below = it.kids.iter().map(|&k| height(items, k, aspect, level)).fold(0.0, f64::max);
        aspect + rows + if it.kids.is_empty() { 0.0 } else { aspect * level + below }
    }
    let total_w: f64 = tops.iter().map(|&t| width(&items, t, gap)).sum::<f64>() + gap * tops.len().saturating_sub(1) as f64;
    let total_h = tops.iter().map(|&t| height(&items, t, aspect, level)).fold(0.0, f64::max);
    let unit = (frame.width() / total_w.max(1e-9)).min(frame.height() / total_h.max(1e-9));
    let (bw, bh) = (unit, unit * aspect);
    let mut boxes: Vec<(Vec<usize>, Rect)> = Vec::new();
    let mut lines: Vec<(kurbo::Point, kurbo::Point)> = Vec::new();
    #[allow(clippy::too_many_arguments)]
    fn place(items: &HashMap<usize, OrgItem>, pt: usize, x: f64, y: f64, unit: f64, bw: f64, bh: f64, gap: f64, level: f64, boxes: &mut Vec<(Vec<usize>, Rect)>, lines: &mut Vec<(kurbo::Point, kurbo::Point)>) -> Rect {
        let it = &items[&pt];
        let w = width(items, pt, gap) * unit;
        let cx = x + w / 2.0;
        let me = Rect::new(cx - bw / 2.0, y, cx + bw / 2.0, y + bh);
        boxes.push((it.path.clone(), me));
        let mut next_y = y + bh;
        if !it.assistants.is_empty() {
            let ay = next_y + bh * level / 2.0;
            for (k, &a) in it.assistants.iter().enumerate() {
                let left = k % 2 == 0;
                let ax = if left { cx - gap * unit - bw } else { cx + gap * unit };
                let r = Rect::new(ax, ay, ax + bw, ay + bh);
                boxes.push((items[&a].path.clone(), r));
                let side = if left { r.x1 } else { r.x0 };
                lines.push(((cx, r.center().y).into(), (side, r.center().y).into()));
            }
            next_y = ay + bh;
        }
        if !it.kids.is_empty() {
            let ky = next_y + bh * level;
            let mid = ky - bh * level / 2.0;
            lines.push(((cx, me.y1).into(), (cx, mid).into()));
            let kids_w: f64 = it.kids.iter().map(|&k| width(items, k, gap)).sum::<f64>() * unit + gap * unit * (it.kids.len() - 1) as f64;
            let mut kx = cx - kids_w / 2.0;
            let mut centers = Vec::new();
            for &k in &it.kids {
                let r = place(items, k, kx, ky, unit, bw, bh, gap, level, boxes, lines);
                centers.push(r.center().x);
                lines.push(((r.center().x, mid).into(), (r.center().x, r.y0).into()));
                kx += (width(items, k, gap) + gap) * unit;
            }
            let (a, b) = (centers.iter().cloned().fold(f64::INFINITY, f64::min).min(cx), centers.iter().cloned().fold(f64::NEG_INFINITY, f64::max).max(cx));
            lines.push(((a, mid).into(), (b, mid).into()));
        } else if !it.assistants.is_empty() {
            lines.push(((cx, me.y1).into(), (cx, next_y - bh / 2.0).into()));
        }
        me
    }
    let mut x = frame.x0 + (frame.width() - total_w * unit) / 2.0;
    let y = frame.y0 + (frame.height() - total_h * unit) / 2.0;
    for &t in &tops {
        place(&items, t, x, y, unit, bw, bh, gap, level, &mut boxes, &mut lines);
        x += (width(&items, t, gap) + gap) * unit;
    }
    // Every node outside the boxes takes no room.
    fn clear(n: &mut LNode) {
        n.rect = Rect::ZERO;
        for c in n.children.iter_mut() {
            clear(c);
        }
    }
    for c in root.children.iter_mut() {
        clear(c);
    }
    for (path, r) in boxes {
        let n = at_mut(root, &path);
        // The box is the hierRoot's first non-hierarchy child.
        if let Some(b) = n.children.iter_mut().find(|c| c.alg != "hierChild" && c.alg != "hierRoot") {
            b.vals.insert("__org".into(), 1.0);
            b.rect = r;
        }
    }
    root.lines = lines;
    true
}

/// Text room of a node at font size `size`: its box less its margins.
pub(super) fn text_box(n: &LNode, size: f64) -> Rect {
    // Within the shape's own text rectangle (a triangle's is small).
    let r = match n.shape.as_deref().filter(|s| !s.is_empty() && *s != "conn" && !n.hide_geom) {
        Some(prst) => super::geometry::text_rect_named(prst, &adj_values(n, prst), n.rect.width(), n.rect.height()).map(|t| t + n.rect.origin().to_vec2()).unwrap_or(n.rect),
        None => n.rect,
    };
    let m = |k: &str| n.vals.get(&format!("__f_{k}")).map(|f| f * size).or_else(|| n.get(k)).unwrap_or(0.0);
    let (l, t, rr, b) = (m("lMarg"), m("tMarg"), m("rMarg"), m("bMarg"));
    if l + rr >= r.width() || t + b >= r.height() {
        return Rect::new(r.x0, r.y0, r.x1, r.y1);
    }
    Rect::new(r.x0 + l, r.y0 + t, r.x1 - rr, r.y1 - b)
}

fn paths_of(n: &LNode, path: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
    out.push(path.clone());
    for i in 0..n.children.len() {
        path.push(i);
        paths_of(&n.children[i], path, out);
        path.pop();
    }
}

/// Lays the diagram out in `frame` and fits its text: each text node takes
/// the largest font size (from its `primFontSz`) at which `fits` says its
/// text fits, applying its rules in order (shrink the font to a size, grow
/// the box by a factor within its parent); nodes made by the same layout
/// node grow alike and share the smallest size. Sizes end up in `__font`.
pub(super) fn fit(root: &mut LNode, model: &Model, frame: Rect, fits: &dyn Fn(&LNode, f64, Rect) -> bool) {
    layout(root, model, frame);
    let mut paths = Vec::new();
    paths_of(root, &mut Vec::new(), &mut paths);
    // Growth each node asks for.
    let mut grow: HashMap<(Vec<usize>, String), (f64, f64)> = HashMap::new();
    for path in &paths {
        let parent_room = if path.is_empty() { frame } else { at(root, &path[..path.len() - 1]).rect };
        let n = at(root, path);
        if n.alg != "tx" || n.text.is_empty() || n.rect.width() <= 0.0 || n.rect.height() <= 0.0 {
            continue;
        }
        let mut size = n.get("primFontSz").unwrap_or(65.0).min(65.0);
        let (mut gw, mut gh) = (1.0f64, 1.0f64);
        let room = |gw: f64, gh: f64, size: f64| {
            let mut m = n.clone();
            let c = m.rect.center();
            let (w, h) = (m.rect.width() * gw, m.rect.height() * gh);
            m.rect = Rect::new(c.x - w / 2.0, c.y - h / 2.0, c.x + w / 2.0, c.y + h / 2.0);
            text_box(&m, size)
        };
        let ok = |gw: f64, gh: f64, size: f64| fits(n, size, room(gw, gh, size));
        if !ok(gw, gh, size) {
            for rule in &n.rules {
                match rule.ty.as_str() {
                    "primFontSz" | "secFontSz" => {
                        let floor = if rule.val.is_finite() { rule.val } else { 5.0 };
                        while size > floor && !ok(gw, gh, size) {
                            size = (size - 0.5).max(floor);
                        }
                    }
                    "w" | "h" => {
                        let wide = rule.ty == "w";
                        let cur = if wide { n.rect.width() } else { n.rect.height() }.max(1e-9);
                        let limit = if wide { parent_room.width() } else { parent_room.height() } / cur;
                        // Grow by up to `fact`, to `val` points, or (INF) as
                        // far as the parent allows.
                        let cap = match (rule_fact(rule), rule.val) {
                            (Some(f), _) => f,
                            (None, v) if v.is_infinite() => limit,
                            (None, v) if v.is_finite() && v > 0.0 => v / cur,
                            _ => 1.0,
                        }
                        .min(limit)
                        .max(1.0);
                        let mut g = 1.0;
                        while g < cap && !ok(if wide { g } else { gw }, if wide { gh } else { g }, size) {
                            g = (g * 1.05).min(cap);
                        }
                        if wide {
                            gw = g;
                        } else {
                            gh = g;
                        }
                    }
                    _ => {}
                }
                if ok(gw, gh, size) {
                    break;
                }
            }
        }
        let key = (path[..path.len().saturating_sub(1)].to_vec(), n.name.clone());
        let e = grow.entry(key).or_insert((1.0, 1.0));
        e.0 = e.0.max(gw);
        e.1 = e.1.max(gh);
    }
    if grow.values().any(|g| g.0 > 1.0 || g.1 > 1.0) {
        for path in &paths {
            let Some(&last) = path.last() else { continue };
            let name = at(root, path).name.clone();
            if let Some(&(gw, gh)) = grow.get(&(path[..path.len() - 1].to_vec(), name)) {
                let _ = last;
                let n = at_mut(root, path);
                n.vals.insert("__gw".into(), gw);
                n.vals.insert("__gh".into(), gh);
            }
        }
        layout(root, model, frame);
    }
    // Final sizes, shared by siblings of the same layout node.
    let mut sizes: HashMap<(Vec<usize>, String), f64> = HashMap::new();
    let mut each = Vec::new();
    for path in &paths {
        let n = at(root, path);
        if n.alg != "tx" || n.text.is_empty() || n.rect.width() <= 0.0 || n.rect.height() <= 0.0 {
            continue;
        }
        let mut size = n.get("primFontSz").unwrap_or(65.0).min(65.0);
        let floor = min_font(n);
        while size > floor && !fits(n, size, text_box(n, size)) {
            size = (size - 0.5).max(floor);
        }
        let key = match n.vals.get("__eq") {
            Some(g) => (Vec::new(), format!("__eq{g}")),
            None => (path[..path.len().saturating_sub(1)].to_vec(), n.name.clone()),
        };
        let e = sizes.entry(key.clone()).or_insert(size);
        *e = e.min(size);
        each.push((path.clone(), key));
    }
    for (path, key) in each {
        let size = sizes[&key];
        at_mut(root, &path).vals.insert("__font".into(), size);
    }
}

/// The growth factor a `w`/`h` rule allows (`fact`).
fn rule_fact(r: &Rule) -> Option<f64> {
    r.fact.filter(|f| f.is_finite() && *f > 0.0)
}

/// The smallest font size the node's rules allow (5 pt without a rule).
pub(super) fn min_font(n: &LNode) -> f64 {
    let ruled = n.rules.iter().filter(|r| (r.ty == "primFontSz" || r.ty == "secFontSz") && r.val.is_finite()).map(|r| r.val).fold(f64::INFINITY, f64::min);
    (if ruled.is_finite() { ruled } else { 5.0 }).max(1.0).min(n.get("primFontSz").unwrap_or(65.0))
}

/// The node's shape adjustments as preset guide values.
pub(super) fn adj_values(n: &LNode, prst: &str) -> Vec<(String, f64)> {
    // Layouts give proportions as fractions and angles in degrees; an
    // adjust value is an angle when its default is (or it is beyond 1).
    let names = super::geometry::adjust_names(prst);
    n.adj
        .iter()
        .filter_map(|(i, v)| {
            let (name, default) = names.get(i.checked_sub(1)?)?;
            let angle = default.abs() > 100_000.0 || (*default == 0.0 && v.abs() > 1.0);
            Some((name.clone(), if angle { v * 60_000.0 } else { v * 100_000.0 }))
        })
        .collect()
}

/// Visits nodes in drawing order (children after parents, by z offset).
pub(super) fn walk<'a>(n: &'a LNode, out: &mut Vec<&'a LNode>) {
    out.push(n);
    let mut kids: Vec<&LNode> = n.children.iter().collect();
    kids.sort_by_key(|c| c.z_off);
    for c in kids {
        walk(c, out);
    }
}

/// Text of data point `p` (its `dgm:t` element), if any.
pub(super) fn text_body(dt: &Tree, model: &Model, p: usize) -> Option<usize> {
    dt.child(model.pts[p].node, NS_DGM, "t")
}

/// Whether the point has any text.
pub(super) fn has_text(dt: &Tree, src: &[u8], model: &Model, p: usize) -> bool {
    text_body(dt, model, p).is_some_and(|t| dt.nodes.iter().enumerate().any(|(i, n)| n.ns.as_deref() == Some(NS_A) && n.local == "t" && n.start > dt.node(t).start && n.end < dt.node(t).end && !dt.text(src, i).unwrap_or_default().is_empty()))
}

use super::text::{self, BodyProps};
use super::{color, geometry, load_part_ns, Ctx, Part};
use present_render::{Item, Paint, Rgba, Stroke};
use std::sync::Arc;

/// Colours of a style label in the diagram's colour definition.
struct StyleColors<'a> {
    part: &'a Part,
    label: Option<usize>,
}

impl Ctx<'_> {
    /// The `i`-th of `n` colours of list `list` (`fillClrLst`...) of style
    /// label `lbl`: `repeat` and `cycle` go round the list, `span` blends
    /// from its first to its last colour.
    fn diagram_color(&self, sc: &StyleColors, list: &str, i: usize, n: usize) -> Option<Option<Rgba>> {
        let t = &sc.part.tree;
        let l = t.child(sc.label?, NS_DGM, list)?;
        let colors: Vec<usize> = t.node(l).children.iter().copied().filter(|&c| t.node(c).ns.as_deref() == Some(NS_A)).collect();
        if colors.is_empty() {
            return Some(None);
        }
        let read = |c: usize| color::read(t, c, &self.colors, None);
        Some(match t.node(l).attr("meth").unwrap_or("repeat") {
            "span" if colors.len() > 1 && n > 1 => {
                let (a, b) = (read(colors[0])?, read(*colors.last().unwrap())?);
                let f = i as f64 / (n - 1) as f64;
                let mix = |x: u8, y: u8| (x as f64 + (y as f64 - x as f64) * f).round() as u8;
                Some(Rgba { r: mix(a.r, b.r), g: mix(a.g, b.g), b: mix(a.b, b.b), a: mix(a.a, b.a) })
            }
            _ => read(colors[i % colors.len()]),
        })
    }

    /// Lays out and draws a SmartArt without a saved drawing.
    pub(super) fn diagram(&mut self, part: &Arc<Part>, frame: usize, base: Affine, rect: Rect, rels: [Option<String>; 4]) -> bool {
        let [dm, lo, qs, cs] = rels;
        let (Some(dm), Some(lo)) = (dm, lo) else { return false };
        let (Ok(data), Ok(layout_part)) = (load_part_ns(self.pres, &dm, NS_DGM), load_part_ns(self.pres, &lo, NS_DGM)) else { return false };
        let colors_part = cs.and_then(|c| load_part_ns(self.pres, &c, NS_DGM).ok());
        let style_part = qs.and_then(|q| load_part_ns(self.pres, &q, NS_DGM).ok());
        let Some(model) = Model::read(&data.tree) else { return false };
        let Some(mut root) = build(&layout_part.tree, &data.tree, &model) else { return false };
        let _ = (part, frame);
        let measure = |n: &LNode, size: f64, room: Rect| {
            let texts: Vec<usize> = n.text.iter().copied().filter(|&p| has_text(&data.tree, &data.src, &model, p)).collect();
            if texts.is_empty() {
                return true;
            }
            let paras = self.diagram_paragraphs(&data, &model, &texts, n);
            let lay = self.diagram_text_layout(&paras, size, room);
            // PowerPoint shrinks text rather than break a word.
            lay.content_height <= room.height() + 0.5 && !overflows(&lay, room.width()) && self.words_fit(&paras, size, room.width())
        };
        fit(&mut root, &model, Rect::new(0.0, 0.0, rect.width(), rect.height()), &measure);
        self.provisional("smartArtLayout");
        let place = base * Affine::translate((rect.x0, rect.y0));
        let mut nodes = Vec::new();
        walk(&root, &mut nodes);
        // Organisation chart lines, in the connector nodes' style.
        if !root.lines.is_empty() {
            let lbl = nodes.iter().find(|n| n.shape.as_deref() == Some("conn")).and_then(|n| n.style_lbl.clone()).unwrap_or_else(|| "parChTrans1D2".into());
            let sc = StyleColors { part: colors_part.as_deref().unwrap_or(&data), label: colors_part.as_ref().and_then(|c| c.tree.nodes.iter().position(|x| x.ns.as_deref() == Some(NS_DGM) && x.local == "styleLbl" && x.attr("name") == Some(lbl.as_str()))) };
            let (_, width) = self.diagram_style(style_part.as_deref(), &lbl);
            let color = self.diagram_color(&sc, "linClrLst", 0, 1).flatten().or_else(|| self.colors.scheme.get("accent1").copied());
            if let Some(c) = color {
                let mut path = kurbo::BezPath::new();
                for (a, b) in &root.lines {
                    path.move_to(*a);
                    path.line_to(*b);
                }
                self.out.scene.items.push(Item::Path { path, transform: place, fill: None, stroke: Some(Stroke { paint: Paint::Solid(c), width: width.unwrap_or(1.0), dashes: Vec::new() }) });
            }
        }
        let fitted: Vec<Option<(f64, Vec<text::Paragraph>)>> = nodes
            .iter()
            .map(|n| {
                let texts: Vec<usize> = n.text.iter().copied().filter(|&p| has_text(&data.tree, &data.src, &model, p)).collect();
                // Only text nodes show text.
                if n.alg != "tx" || texts.is_empty() || n.rect.width() <= 0.0 {
                    return None;
                }
                Some((n.vals.get("__font").copied().unwrap_or(18.0), self.diagram_paragraphs(&data, &model, &texts, n)))
            })
            .collect();
        for (n, f) in nodes.iter().zip(fitted) {
            // The point's own style label first, then the layout node's.
            let pres_set = model.pres_point(&n.name, n.pt).and_then(|p| data.tree.child(model.pts[p].node, NS_DGM, "prSet"));
            let lbl = pres_set.and_then(|ps| data.tree.node(ps).attr("presStyleLbl")).map(str::to_owned).or_else(|| n.style_lbl.clone()).unwrap_or_else(|| "node0".into());
            let sc = StyleColors { part: colors_part.as_deref().unwrap_or(&data), label: colors_part.as_ref().and_then(|c| c.tree.nodes.iter().position(|x| x.ns.as_deref() == Some(NS_DGM) && x.local == "styleLbl" && x.attr("name") == Some(lbl.as_str()))) };
            let (fill_on, line_w) = self.diagram_style(style_part.as_deref(), &lbl);
            // The point's place among its style peers (presStyleIdx/Cnt).
            let (idx, cnt) = model.pres_point(&n.name, n.pt).and_then(|p| data.tree.child(model.pts[p].node, NS_DGM, "prSet")).map(|ps| {
                let a = |k: &str| data.tree.node(ps).attr(k).and_then(|v| v.parse::<usize>().ok());
                (a("presStyleIdx").unwrap_or(n.index), a("presStyleCnt").unwrap_or(n.count))
            }).unwrap_or((n.index, n.count));
            // A shape turned a quarter is drawn in the swapped box, so that
            // turned it fills the node's box.
            let turn = n.rot + n.shape_rot;
            let quarter = ((turn.rem_euclid(180.0)) - 90.0).abs() < 1.0 && n.shape_rot != 0.0;
            let (w, h) = if quarter { (n.rect.height(), n.rect.width()) } else { (n.rect.width(), n.rect.height()) };
            let c = n.rect.center();
            let shape_t = place * Affine::translate((c.x, c.y)) * Affine::rotate(turn.to_radians()) * Affine::translate((-w / 2.0, -h / 2.0));
            if let Some(kind) = n.shape.as_deref().filter(|k| !k.is_empty() && !n.hide_geom) {
                let prst = if kind == "conn" { "rightArrow" } else { kind };
                let adj = adj_values(n, prst);
                if let Some(g) = geometry::preset_named(prst, &adj, w, h) {
                    let mut fill = if fill_on { self.diagram_color(&sc, "fillClrLst", idx, cnt).flatten().map(Paint::Solid) } else { None };
                    let mut line = line_w.and_then(|lw| self.diagram_color(&sc, "linClrLst", idx, cnt).flatten().map(|c| Stroke { paint: Paint::Solid(c), width: lw, dashes: Vec::new() }));
                    // Formatting a user gave the point (kept on the data
                    // point when this shape shows it), then on its shape.
                    let own = n.text.first().copied().filter(|&p| matches!(model.pts[p].kind, PtType::Node | PtType::Asst));
                    for source in own.into_iter().chain(model.pres_point(&n.name, n.pt)) {
                        if let Some(sp) = data.tree.child(model.pts[source].node, NS_DGM, "spPr") {
                            for &c in &data.tree.node(sp).children {
                                match data.tree.node(c).local.as_str() {
                                    "noFill" | "solidFill" | "gradFill" => fill = self.paint_from_fill(&data, c, None, Rect::new(0.0, 0.0, w, h), None).ok().flatten(),
                                    "ln" => {
                                        let lt = &data.tree;
                                        if lt.child(c, NS_A, "noFill").is_some() {
                                            line = None;
                                        } else if let Some(f) = lt.child(c, NS_A, "solidFill") {
                                            let wpt = lt.node(c).attr("w").and_then(|v| v.parse::<f64>().ok()).map(|v| v / 12_700.0);
                                            line = self.paint_from_fill(&data, f, None, Rect::ZERO, None).ok().flatten().map(|p| Stroke { paint: p, width: wpt.unwrap_or(0.75), dashes: Vec::new() });
                                        }
                                    }
                                    _ => {}
                                }
                            }
                        }
                    }
                    if fill.is_some() && !g.fill.elements().is_empty() {
                        self.out.scene.items.push(Item::Path { path: g.fill.clone(), transform: shape_t, fill, stroke: None });
                    }
                    if line.is_some() && !g.stroke.elements().is_empty() {
                        self.out.scene.items.push(Item::Path { path: g.stroke, transform: shape_t, fill: None, stroke: line });
                    }
                }
            }
            if let Some((size, mut paras)) = f {
                let tc = self.diagram_color(&sc, "txFillClrLst", idx, cnt).flatten().or_else(|| self.diagram_font_color(style_part.as_deref(), &lbl));
                for p in paras.iter_mut() {
                    for r in p.runs.iter_mut() {
                        if r.props.color.is_none() {
                            r.props.color = tc;
                        }
                    }
                    if p.end_props.color.is_none() {
                        p.end_props.color = tc;
                    }
                }
                let room = text_box(n, size);
                let mut lay = self.diagram_text_layout(&paras, size, room);
                let t = place * Affine::translate((room.x0, room.y0));
                self.emit_text(&mut lay, t);
            }
        }
        true
    }

    /// The font colour style label `lbl` gives (`fontRef` colour).
    fn diagram_font_color(&self, qs: Option<&Part>, lbl: &str) -> Option<Rgba> {
        let t = &qs?.tree;
        let l = t.nodes.iter().position(|x| x.ns.as_deref() == Some(NS_DGM) && x.local == "styleLbl" && x.attr("name") == Some(lbl))?;
        let f = t.path(l, &[(NS_DGM, "style"), (NS_A, "fontRef")])?;
        color::read_child(t, f, &self.colors, None)
    }

    /// Whether style label `lbl` fills shapes, and its line width (none
    /// when it draws no line), from the diagram's style definition and the
    /// theme's line styles.
    fn diagram_style(&self, qs: Option<&Part>, lbl: &str) -> (bool, Option<f64>) {
        let Some(q) = qs else { return (true, Some(1.0)) };
        let t = &q.tree;
        let Some(l) = t.nodes.iter().position(|x| x.ns.as_deref() == Some(NS_DGM) && x.local == "styleLbl" && x.attr("name") == Some(lbl)) else { return (true, Some(1.0)) };
        let style = t.child(l, NS_DGM, "style");
        let idx = |k: &str| style.and_then(|s| t.child(s, NS_A, k)).and_then(|r| t.node(r).attr("idx")).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
        let fill = idx("fillRef") > 0;
        let ln = idx("lnRef");
        let width = ln.checked_sub(1).and_then(|i| self.theme.line_styles.get(i)).map(|&l| {
            let tt = &self.theme.part.tree;
            tt.node(l).attr("w").and_then(|v| v.parse::<f64>().ok()).map(|v| v / 12_700.0).unwrap_or(0.75)
        });
        (fill, width)
    }

    fn diagram_paragraphs(&self, data: &Part, model: &Model, texts: &[usize], n: &LNode) -> Vec<text::Paragraph> {
        let mut out = Vec::new();
        let overlay = text::RunProps::default();
        for (k, &p) in texts.iter().enumerate() {
            let Some(body) = text_body(&data.tree, model, p) else { continue };
            let mut paras = self.paragraphs(data, body, &[], &overlay);
            for para in paras.iter_mut() {
                if para.props.align.is_none() {
                    para.props.align = Some(if k == 0 && texts.len() == 1 { "ctr".into() } else if k == 0 { "ctr".into() } else { "l".into() });
                }
                // Later points (children shown in the node) are smaller.
                if k > 0 {
                    for r in para.runs.iter_mut() {
                        r.props.size = Some(r.props.size.unwrap_or(1.0) * 0.78);
                    }
                }
            }
            out.extend(paras);
        }
        let _ = n;
        out
    }

    /// Whether every space-separated word of `paras` fits on one line of
    /// `width` at `size`.
    fn words_fit(&self, paras: &[text::Paragraph], size: f64, width: f64) -> bool {
        for p in paras {
            for r in &p.runs {
                for word in r.text.split_whitespace() {
                    let mut one = p.clone();
                    let mut run = r.clone();
                    run.text = word.to_owned();
                    one.runs = vec![run];
                    let body = BodyProps { insets: [0.0; 4], wrap: false, ..Default::default() };
                    let mut ps = vec![one];
                    for q in ps.iter_mut() {
                        for x in q.runs.iter_mut() {
                            x.props.size = Some(match x.props.size {
                                Some(f) if f <= 1.0 => size * f,
                                Some(f) => f.min(size),
                                None => size,
                            });
                        }
                    }
                    let lay = text::layout(&ps, &body, 10_000.0, 10_000.0, self.fonts, &self.theme.fonts);
                    if lay.lines.iter().any(|l| l.width > width + 0.5) {
                        return false;
                    }
                }
            }
        }
        true
    }

    fn diagram_text_layout(&self, paras: &[text::Paragraph], size: f64, room: Rect) -> text::TextLayout {
        let mut ps = paras.to_vec();
        for p in ps.iter_mut() {
            for r in p.runs.iter_mut() {
                // Relative sizes (children) scale with the node's size; a size
                // set on the text is a most.
                r.props.size = Some(match r.props.size {
                    Some(f) if f <= 1.0 => size * f,
                    Some(f) => f.min(size),
                    None => size,
                });
            }
            p.end_props.size = Some(size);
        }
        let body = BodyProps { insets: [0.0; 4], anchor: "ctr".into(), wrap: true, ..Default::default() };
        text::layout(&ps, &body, room.width().max(1.0), room.height().max(1.0), self.fonts, &self.theme.fonts)
    }
}

/// Whether any line is wider than the room (a word that cannot wrap).
fn overflows(lay: &text::TextLayout, width: f64) -> bool {
    lay.lines.iter().any(|l| l.width > width + 0.5)
}

/// The laid-out node tree of each SmartArt on a slide, as text (for
/// comparing with PowerPoint's cached layouts while developing).
pub fn dump(pres: &crate::Presentation, slide: usize) -> String {
    let mut out = String::new();
    let Ok(part_name) = pres.slide_part(slide) else { return out };
    let Ok(part) = load_part_ns(pres, part_name, crate::xml::NS_P) else { return out };
    let t = &part.tree;
    for (i, n) in t.nodes.iter().enumerate() {
        if n.local != "relIds" {
            continue;
        }
        let rel = |k: &str| n.attr_ns(crate::xml::NS_R, k).and_then(|r| part.rels.iter().find(|x| x.id == r)).map(|r| r.target.clone());
        let (Some(dm), Some(lo)) = (rel("dm"), rel("lo")) else { continue };
        let (Ok(data), Ok(lp)) = (load_part_ns(pres, &dm, NS_DGM), load_part_ns(pres, &lo, NS_DGM)) else { continue };
        let Some(model) = Model::read(&data.tree) else { continue };
        let Some(mut root) = build(&lp.tree, &data.tree, &model) else { continue };
        // The frame size.
        let mut at = Some(i);
        let mut size = (0.0, 0.0);
        while let Some(a) = at {
            if t.node(a).local == "graphicFrame" {
                if let Some(x) = t.child(a, crate::xml::NS_P, "xfrm").and_then(|x| super::read_xfrm(t, x)) {
                    size = (x.rect.width(), x.rect.height());
                }
                break;
            }
            at = t.node(a).parent;
        }
        layout(&mut root, &model, Rect::new(0.0, 0.0, size.0, size.1));
        fn show(n: &LNode, data: &Tree, src: &[u8], model: &Model, depth: usize, out: &mut String) {
            let text: Vec<String> = n.text.iter().map(|&p| {
                let mut s = String::new();
                if let Some(b) = text_body(data, model, p) {
                    for (k, x) in data.nodes.iter().enumerate() {
                        if x.ns.as_deref() == Some(NS_A) && x.local == "t" && x.start > data.node(b).start && x.end < data.node(b).end {
                            s.push_str(&data.text(src, k).unwrap_or_default());
                        }
                    }
                }
                s.chars().take(12).collect()
            }).collect();
            let mut vals: Vec<String> = n.vals.iter().filter(|(k, _)| !k.starts_with("__") || k.as_str() == "__font").map(|(k, v)| format!("{k}={v:.1}")).collect();
            vals.sort();
            out.push_str(&format!("{}{} alg={} shape={:?} [{:.1},{:.1} {:.1}x{:.1}] rot={:.0} text={:?} {}\n", "  ".repeat(depth), n.name, n.alg, n.shape, n.rect.x0, n.rect.y0, n.rect.width(), n.rect.height(), n.rot, text, vals.join(" ")));
            for c in &n.children {
                show(c, data, src, model, depth + 1, out);
            }
        }
        show(&root, &data.tree, &data.src, &model, 0, &mut out);
        out.push('\n');
    }
    out
}
