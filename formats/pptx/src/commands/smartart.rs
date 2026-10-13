//! SmartArt edits on the diagram's data model, where PowerPoint keeps the
//! content: it lays the diagram out from the data when it opens it (the
//! saved drawing is a cache). A text change also updates the drawing's shape
//! for that node when the shape shows only that node's text; adding or
//! removing a node empties the drawing, so PowerPoint (and this engine) lay
//! the diagram out again.

use serde_json::{json, Value};
use sha2::Digest;

use super::build_paragraph;
use super::shape::target;
use crate::xml::{escape_text, splice, Tree, NS_A, NS_R};
use crate::{read_relationships, rels_part_for, Error, Presentation};

const NS_DGM: &str = "http://schemas.openxmlformats.org/drawingml/2006/diagram";
const NS_DSP: &str = "http://schemas.microsoft.com/office/drawing/2008/diagram";

struct Diagram {
    data_name: String,
    src: Vec<u8>,
    tree: Tree,
    drawing: Option<String>,
}

fn diagram(doc: &Presentation, slide: usize, id: u32) -> Result<Diagram, Error> {
    let t = target(doc, slide, id)?;
    let tree = &t.tree;
    let ids = tree
        .nodes
        .iter()
        .enumerate()
        .find(|(_, n)| n.ns.as_deref() == Some(NS_DGM) && n.local == "relIds" && n.start >= tree.node(t.shape).start && n.end <= tree.node(t.shape).end)
        .map(|(i, _)| i)
        .ok_or_else(|| Error::InvalidCommand(format!("shape {id} is not a SmartArt graphic")))?;
    let rels = read_relationships(doc.package(), &rels_part_for(&t.part), &t.part)?;
    let rid = tree.node(ids).attr_ns(NS_R, "dm").ok_or_else(|| Error::Xml("SmartArt without data".into()))?;
    let data_name = rels.iter().find(|r| r.id == rid).map(|r| r.target.clone()).ok_or_else(|| Error::NotFound("SmartArt data part".into()))?;
    let src = doc.package().read(&data_name)?.to_vec();
    let dtree = Tree::parse(&src)?;
    if dtree.node(dtree.root).prefix() != "dgm:" {
        return Err(Error::Unsupported("SmartArt data without the usual dgm: prefix".into()));
    }
    let drawing = dtree.nodes.iter().find(|n| n.local == "dataModelExt").and_then(|n| n.attr("relId")).and_then(|r| rels.iter().find(|x| x.id == r)).map(|r| r.target.clone());
    Ok(Diagram { data_name, src, tree: dtree, drawing })
}

/// Content points in document order (depth first), with their depth, and
/// the parOf connections.
struct Content {
    nodes: Vec<(usize, usize)>,
    /// (cxn element, src point index, dest point index, srcOrd)
    links: Vec<(usize, usize, usize, i64)>,
    by_id: std::collections::HashMap<String, usize>,
    doc: usize,
}

fn content(d: &Diagram) -> Result<Content, Error> {
    let t = &d.tree;
    let pts = t.child(t.root, NS_DGM, "ptLst").ok_or_else(|| Error::Xml("SmartArt data without points".into()))?;
    let mut by_id = std::collections::HashMap::new();
    let mut doc = None;
    for p in t.children_named(pts, NS_DGM, "pt") {
        let n = t.node(p);
        if let Some(id) = n.attr("modelId") {
            by_id.insert(id.to_owned(), p);
        }
        if n.attr("type") == Some("doc") {
            doc = Some(p);
        }
    }
    let doc = doc.ok_or_else(|| Error::Xml("SmartArt data without a document point".into()))?;
    let mut links = Vec::new();
    if let Some(cl) = t.child(t.root, NS_DGM, "cxnLst") {
        for c in t.children_named(cl, NS_DGM, "cxn") {
            let n = t.node(c);
            if n.attr("type").unwrap_or("parOf") != "parOf" {
                continue;
            }
            if let (Some(&s), Some(&dd)) = (n.attr("srcId").and_then(|x| by_id.get(x)), n.attr("destId").and_then(|x| by_id.get(x))) {
                links.push((c, s, dd, n.attr("srcOrd").and_then(|v| v.parse().ok()).unwrap_or(0)));
            }
        }
    }
    let mut nodes = Vec::new();
    fn walk(p: usize, depth: usize, links: &[(usize, usize, usize, i64)], t: &Tree, out: &mut Vec<(usize, usize)>) {
        let mut kids: Vec<&(usize, usize, usize, i64)> = links.iter().filter(|l| l.1 == p).collect();
        kids.sort_by_key(|l| l.3);
        for k in kids {
            if matches!(t.node(k.2).attr("type").unwrap_or("node"), "node" | "asst") {
                out.push((k.2, depth));
                walk(k.2, depth + 1, links, t, out);
            }
        }
    }
    walk(doc, 1, &links, t, &mut nodes);
    Ok(Content { nodes, links, by_id, doc })
}

fn point_text(t: &Tree, src: &[u8], p: usize) -> String {
    let Some(body) = t.child(p, NS_DGM, "t") else { return String::new() };
    t.children_named(body, NS_A, "p")
        .map(|para| t.nodes.iter().enumerate().filter(|(_, n)| n.ns.as_deref() == Some(NS_A) && n.local == "t" && n.start > t.node(para).start && n.end < t.node(para).end).map(|(i, _)| t.text(src, i).unwrap_or_default()).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The diagram's nodes for `observe`: index, depth and text.
pub fn smartart_nodes(doc: &Presentation, slide: usize, id: u32) -> Result<Vec<Value>, Error> {
    let d = diagram(doc, slide, id)?;
    let c = content(&d)?;
    Ok(c.nodes.iter().enumerate().map(|(i, &(p, depth))| json!({ "index": i, "depth": depth, "text": point_text(&d.tree, &d.src, p), "assistant": d.tree.node(p).attr("type") == Some("asst") })).collect())
}

/// New paragraphs for text body `body` (a `dgm:t` or `dsp:txBody`): one per
/// line of `text`, each formatted like the old paragraph at its place (or
/// the last).
fn paragraphs(t: &Tree, src: &[u8], body: usize, text: &str) -> Result<Vec<u8>, Error> {
    let paras: Vec<usize> = t.children_named(body, NS_A, "p").collect();
    let Some(&last) = paras.last() else { return Err(Error::Xml("text without paragraphs".into())) };
    let mut out = Vec::new();
    for (k, line) in text.split('\n').enumerate() {
        out.extend(build_paragraph(t, src, *paras.get(k).unwrap_or(&last), line)?);
    }
    Ok(out)
}

/// Replaces the paragraphs of text body `body` with `text`.
fn text_edit(t: &Tree, src: &[u8], body: usize, text: &str) -> Result<(std::ops::Range<usize>, Vec<u8>), Error> {
    let paras: Vec<usize> = t.children_named(body, NS_A, "p").collect();
    let (Some(&first), Some(&last)) = (paras.first(), paras.last()) else { return Err(Error::Xml("text without paragraphs".into())) };
    Ok((t.node(first).start..t.node(last).end, paragraphs(t, src, body, text)?))
}

fn check_text(text: &str) -> Result<(), Error> {
    if text.chars().any(|c| c.is_control() && c != '\n' && c != '\t' && c != '\u{b}') {
        return Err(Error::InvalidCommand("text must not contain control characters".into()));
    }
    Ok(())
}

/// Empties the saved drawing so the diagram is laid out again.
fn clear_drawing(doc: &mut Presentation, drawing: &Option<String>) -> Result<bool, Error> {
    let Some(name) = drawing else { return Ok(false) };
    let src = doc.package().read(name)?.to_vec();
    let t = Tree::parse(&src)?;
    let Some(sp_tree) = t.child(t.root, NS_DSP, "spTree") else { return Ok(false) };
    let kids: Vec<usize> = t.node(sp_tree).children.iter().copied().filter(|&c| matches!(t.node(c).local.as_str(), "sp" | "grpSp")).collect();
    if kids.is_empty() {
        return Ok(false);
    }
    let edits = kids.iter().map(|&k| (t.node(k).start..t.node(k).end, Vec::new())).collect();
    doc.package_mut().write(name, splice(&src, edits)?)?;
    Ok(true)
}

/// Sets the text of node `index` (lines become paragraphs).
pub fn set_smartart_node(doc: &mut Presentation, slide: usize, id: u32, index: usize, text: &str) -> Result<Value, Error> {
    check_text(text)?;
    let d = diagram(doc, slide, id)?;
    let c = content(&d)?;
    let &(p, _) = c.nodes.get(index).ok_or_else(|| Error::NotFound(format!("SmartArt node {index} (it has {})", c.nodes.len())))?;
    let t = &d.tree;
    let old = point_text(t, &d.src, p);
    let edit = match t.child(p, NS_DGM, "t") {
        Some(body) => text_edit(t, &d.src, body, text)?,
        None => {
            let at = t.child(p, NS_DGM, "spPr").map(|s| t.node(s).end).unwrap_or(t.node(p).close_start);
            let paras: String = text.split('\n').map(|l| format!("<a:p><a:r><a:rPr lang=\"en-US\" dirty=\"0\"/><a:t>{}</a:t></a:r></a:p>", escape_text(l))).collect();
            (at..at, format!("<dgm:t><a:bodyPr/><a:lstStyle/>{paras}</dgm:t>").into_bytes())
        }
    };
    let updated = splice(&d.src, vec![edit])?;
    Tree::parse(&updated)?;
    doc.package_mut().write(&d.data_name, updated)?;
    // The drawing's shape for this node, when it shows just this text.
    let model_id = t.node(p).attr("modelId").unwrap_or_default().to_owned();
    let pres: Vec<String> = t
        .nodes
        .iter()
        .filter(|n| n.local == "prSet" && n.attr("presAssocID") == Some(model_id.as_str()))
        .filter_map(|n| n.parent.and_then(|pp| t.node(pp).attr("modelId")).map(str::to_owned))
        .collect();
    let mut drawing_updated = false;
    if let Some(name) = &d.drawing {
        let src = doc.package().read(name)?.to_vec();
        let dt = Tree::parse(&src)?;
        let shape = dt.nodes.iter().enumerate().find(|(_, n)| n.local == "sp" && n.attr("modelId").is_some_and(|m| pres.iter().any(|x| x == m))).map(|(i, _)| i);
        let body = shape.and_then(|s| dt.child(s, NS_DSP, "txBody"));
        let same = body.is_some_and(|b| {
            let shown: String = dt.children_named(b, NS_A, "p").map(|para| dt.nodes.iter().enumerate().filter(|(_, n)| n.local == "t" && n.ns.as_deref() == Some(NS_A) && n.start > dt.node(para).start && n.end < dt.node(para).end).map(|(i, _)| dt.text(&src, i).unwrap_or_default()).collect::<String>()).collect::<Vec<_>>().join("\n");
            shown == old
        });
        match (body, same) {
            (Some(b), true) => {
                let e = text_edit(&dt, &src, b, text)?;
                doc.package_mut().write(name, splice(&src, vec![e])?)?;
                drawing_updated = true;
            }
            _ => {
                clear_drawing(doc, &d.drawing)?;
            }
        }
    }
    Ok(json!({ "op": "set_smartart_node", "slide": slide, "shapeId": id, "index": index, "changed": old != text, "drawing": if drawing_updated { "updated" } else { "relaid" } }))
}

fn guid(seed: &str) -> String {
    let h = sha2::Sha256::digest(seed.as_bytes());
    let x: String = h.iter().take(16).map(|b| format!("{b:02X}")).collect();
    format!("{{{}-{}-{}-{}-{}}}", &x[0..8], &x[8..12], &x[12..16], &x[16..20], &x[20..32])
}

/// Adds a node with `text` under node `parent` (None: at the top level) at
/// position `at` among its children (default last).
pub fn add_smartart_node(doc: &mut Presentation, slide: usize, id: u32, parent: Option<usize>, at: Option<usize>, text: &str) -> Result<Value, Error> {
    check_text(text)?;
    let d = diagram(doc, slide, id)?;
    let c = content(&d)?;
    let t = &d.tree;
    let par = match parent {
        Some(i) => c.nodes.get(i).map(|n| n.0).ok_or_else(|| Error::NotFound(format!("SmartArt node {i} (it has {})", c.nodes.len())))?,
        None => c.doc,
    };
    let mut siblings: Vec<&(usize, usize, usize, i64)> = c.links.iter().filter(|l| l.1 == par && matches!(t.node(l.2).attr("type").unwrap_or("node"), "node")).collect();
    siblings.sort_by_key(|l| l.3);
    let pos = at.unwrap_or(siblings.len());
    if pos > siblings.len() {
        return Err(Error::NotFound(format!("position {pos} (the parent has {} children)", siblings.len())));
    }
    let ord = siblings.get(pos).map(|l| l.3).unwrap_or_else(|| siblings.last().map(|l| l.3 + 1).unwrap_or(0));
    let seed = format!("{}:{}:{}", d.data_name, d.src.len(), c.by_id.len());
    let (node_id, par_id, sib_id, cxn_id) = (guid(&format!("{seed}:n")), guid(&format!("{seed}:p")), guid(&format!("{seed}:s")), guid(&format!("{seed}:c")));
    let src_id = t.node(par).attr("modelId").unwrap_or_default();
    // A copy of a sibling's text formatting, else plain.
    let like = siblings.get(pos).or(siblings.last()).map(|l| l.2);
    let body = match like.and_then(|l| t.child(l, NS_DGM, "t")) {
        Some(b) => {
            let n = t.node(b);
            let head = String::from_utf8_lossy(&d.src[n.start..t.children_named(b, NS_A, "p").next().map(|p| t.node(p).start).unwrap_or(n.close_start)]).into_owned();
            let paras = String::from_utf8(paragraphs(t, &d.src, b, text)?).map_err(|e| Error::Xml(e.to_string()))?;
            format!("{head}{paras}</{}>", n.qname)
        }
        None => format!("<dgm:t><a:bodyPr/><a:lstStyle/>{}</dgm:t>", text.split('\n').map(|l| format!("<a:p><a:r><a:rPr lang=\"en-US\"/><a:t>{}</a:t></a:r></a:p>", escape_text(l))).collect::<String>()),
    };
    let trans = |pid: &str, ty: &str| format!(r#"<dgm:pt modelId="{pid}" type="{ty}" cxnId="{cxn_id}"><dgm:prSet/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></dgm:t></dgm:pt>"#);
    let pts = format!(r#"<dgm:pt modelId="{node_id}"><dgm:prSet phldrT="[Text]"/><dgm:spPr/>{body}</dgm:pt>{}{}"#, trans(&par_id, "parTrans"), trans(&sib_id, "sibTrans"));
    let cxn = format!(r#"<dgm:cxn modelId="{cxn_id}" srcId="{src_id}" destId="{node_id}" srcOrd="{ord}" destOrd="0" parTransId="{par_id}" sibTransId="{sib_id}"/>"#);
    let pt_lst = t.child(t.root, NS_DGM, "ptLst").ok_or_else(|| Error::Xml("no ptLst".into()))?;
    let cxn_lst = t.child(t.root, NS_DGM, "cxnLst").ok_or_else(|| Error::Unsupported("SmartArt data without connections".into()))?;
    let mut edits = vec![(t.node(pt_lst).close_start..t.node(pt_lst).close_start, pts.into_bytes()), (t.node(cxn_lst).close_start..t.node(cxn_lst).close_start, cxn.into_bytes())];
    // Later siblings move one place on.
    for l in siblings.iter().skip(pos) {
        let n = t.node(l.0);
        edits.push((n.start..n.open_end, super::xmledit::start_tag(&d.src, t, l.0, &[("srcOrd", Some((l.3 + 1).to_string()))], n.open_end == n.end)?));
    }
    let updated = splice(&d.src, edits)?;
    Tree::parse(&updated)?;
    doc.package_mut().write(&d.data_name, updated)?;
    clear_drawing(doc, &d.drawing)?;
    let after = diagram(doc, slide, id)?;
    let index = content(&after)?.nodes.iter().position(|n| after.tree.node(n.0).attr("modelId") == Some(node_id.as_str())).unwrap_or(0);
    Ok(json!({ "op": "add_smartart_node", "slide": slide, "shapeId": id, "index": index, "changed": true }))
}

/// Deletes node `index` with the nodes under it, their transitions,
/// connections and presentation points.
pub fn delete_smartart_node(doc: &mut Presentation, slide: usize, id: u32, index: usize) -> Result<Value, Error> {
    let d = diagram(doc, slide, id)?;
    let c = content(&d)?;
    let t = &d.tree;
    let &(p, depth) = c.nodes.get(index).ok_or_else(|| Error::NotFound(format!("SmartArt node {index} (it has {})", c.nodes.len())))?;
    if c.nodes.len() == 1 {
        return Err(Error::InvalidCommand("a SmartArt keeps at least one node".into()));
    }
    // The node and everything under it.
    let mut gone = vec![p];
    for &(q, dq) in c.nodes.iter().skip(index + 1) {
        if dq <= depth {
            break;
        }
        gone.push(q);
    }
    let ids: std::collections::HashSet<String> = gone.iter().filter_map(|&q| t.node(q).attr("modelId").map(str::to_owned)).collect();
    let mut drop_ids = ids.clone();
    let cxn_lst = t.child(t.root, NS_DGM, "cxnLst");
    let mut edits = Vec::new();
    // Connections touching them; their transitions.
    let mut parent_link = None;
    if let Some(cl) = cxn_lst {
        for cx in t.children_named(cl, NS_DGM, "cxn") {
            let n = t.node(cx);
            let (s, dd) = (n.attr("srcId").unwrap_or_default(), n.attr("destId").unwrap_or_default());
            if ids.contains(dd) || ids.contains(s) {
                if n.attr("type").unwrap_or("parOf") == "parOf" && dd == t.node(p).attr("modelId").unwrap_or_default() {
                    parent_link = Some((s.to_owned(), n.attr("srcOrd").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0)));
                }
                for k in ["parTransId", "sibTransId"] {
                    if let Some(x) = n.attr(k) {
                        drop_ids.insert(x.to_owned());
                    }
                }
                edits.push((n.start..n.end, Vec::new()));
            }
        }
    }
    // Presentation points of removed points, and connections to them.
    let pt_lst = t.child(t.root, NS_DGM, "ptLst").ok_or_else(|| Error::Xml("no ptLst".into()))?;
    for q in t.children_named(pt_lst, NS_DGM, "pt") {
        let assoc = t.child(q, NS_DGM, "prSet").and_then(|s| t.node(s).attr("presAssocID"));
        if assoc.is_some_and(|a| drop_ids.contains(a)) {
            if let Some(m) = t.node(q).attr("modelId") {
                drop_ids.insert(m.to_owned());
            }
        }
    }
    if let Some(cl) = cxn_lst {
        for cx in t.children_named(cl, NS_DGM, "cxn") {
            let n = t.node(cx);
            let touches = [n.attr("srcId"), n.attr("destId")].iter().flatten().any(|x| drop_ids.contains(*x));
            if touches && !edits.iter().any(|(r, _): &(std::ops::Range<usize>, Vec<u8>)| r.start == n.start) {
                edits.push((n.start..n.end, Vec::new()));
            }
        }
    }
    for q in t.children_named(pt_lst, NS_DGM, "pt") {
        if t.node(q).attr("modelId").is_some_and(|m| drop_ids.contains(m)) {
            edits.push((t.node(q).start..t.node(q).end, Vec::new()));
        }
    }
    // Later siblings move one place back.
    if let (Some((parent, ord)), Some(cl)) = (parent_link, cxn_lst) {
        for cx in t.children_named(cl, NS_DGM, "cxn") {
            let n = t.node(cx);
            if n.attr("type").unwrap_or("parOf") == "parOf" && n.attr("srcId") == Some(parent.as_str()) {
                let o: i64 = n.attr("srcOrd").and_then(|v| v.parse().ok()).unwrap_or(0);
                if o > ord && !edits.iter().any(|(r, _)| r.start == n.start) {
                    edits.push((n.start..n.open_end, super::xmledit::start_tag(&d.src, t, cx, &[("srcOrd", Some((o - 1).to_string()))], n.open_end == n.end)?));
                }
            }
        }
    }
    let updated = splice(&d.src, edits)?;
    Tree::parse(&updated)?;
    doc.package_mut().write(&d.data_name, updated)?;
    clear_drawing(doc, &d.drawing)?;
    Ok(json!({ "op": "delete_smartart_node", "slide": slide, "shapeId": id, "index": index, "removed": gone.len(), "changed": true }))
}
