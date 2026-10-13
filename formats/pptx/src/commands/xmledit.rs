//! Rebuilds one element with changed attributes or children while copying
//! everything else in it byte for byte.

use quick_xml::events::BytesStart;

use crate::xml::{escape_text, Tree, NS_A};
use crate::Error;

/// Changes to an element: attributes to set (`Some`) or remove (`None`),
/// child elements (by DrawingML local name) to remove, and new children to
/// insert at their place in `order`.
#[derive(Default)]
pub struct Change<'a> {
    pub attrs: Vec<(&'a str, Option<String>)>,
    pub remove: Vec<&'a str>,
    pub insert: Vec<(&'a str, Vec<u8>)>,
    /// Schema order of the element's children; unknown names sort last.
    pub order: &'a [&'a str],
}

/// The element's start tag with `attrs` applied, as `<name ...>` (or
/// `<name .../>` when `empty`). Other attributes keep their raw text and order.
pub fn start_tag(src: &[u8], tree: &Tree, node: usize, attrs: &[(&str, Option<String>)], empty: bool) -> Result<Vec<u8>, Error> {
    let n = tree.node(node);
    let raw = &src[n.start + 1..n.open_end - if n.is_empty_element() { 2 } else { 1 }];
    let tag = BytesStart::from_content(std::str::from_utf8(raw).map_err(|e| Error::Xml(e.to_string()))?, n.qname.len());
    let mut out = format!("<{}", n.qname).into_bytes();
    let mut done = vec![false; attrs.len()];
    for a in tag.attributes().with_checks(false) {
        let a = a.map_err(|e| Error::Xml(e.to_string()))?;
        let key = a.key.as_ref();
        match attrs.iter().position(|(k, _)| k.as_bytes() == key) {
            Some(i) => {
                done[i] = true;
                if let Some(v) = &attrs[i].1 {
                    out.extend_from_slice(format!(" {}=\"{}\"", attrs[i].0, escape_attr(v)).as_bytes());
                }
            }
            None => {
                out.push(b' ');
                out.extend_from_slice(key);
                out.extend_from_slice(b"=\"");
                out.extend_from_slice(&a.value);
                out.push(b'"');
            }
        }
    }
    for (i, (k, v)) in attrs.iter().enumerate() {
        if let (false, Some(v)) = (done[i], v) {
            out.extend_from_slice(format!(" {k}=\"{}\"", escape_attr(v)).as_bytes());
        }
    }
    out.extend_from_slice(if empty { b"/>" } else { b">" });
    Ok(out)
}

pub fn escape_attr(v: &str) -> String {
    escape_text(v).replace('"', "&quot;")
}

/// The element rebuilt with `change` applied.
pub fn rebuild(src: &[u8], tree: &Tree, node: usize, change: &Change) -> Result<Vec<u8>, Error> {
    let n = tree.node(node);
    let rank = |local: &str| change.order.iter().position(|o| *o == local).unwrap_or(usize::MAX);
    let kept: Vec<usize> = n.children.iter().copied().filter(|&c| !(tree.node(c).ns.as_deref() == Some(NS_A) && change.remove.contains(&tree.node(c).local.as_str()))).collect();
    let mut inserts: Vec<&(&str, Vec<u8>)> = change.insert.iter().collect();
    inserts.sort_by_key(|(l, _)| rank(l));
    let has_content = !kept.is_empty() || !inserts.is_empty() || (!n.is_empty_element() && n.children.is_empty() && n.close_start > n.open_end);
    if !has_content {
        return start_tag(src, tree, node, &change.attrs, true);
    }
    let mut out = start_tag(src, tree, node, &change.attrs, false)?;
    let mut pending = inserts.into_iter().peekable();
    let mut at = if n.is_empty_element() { n.end } else { n.open_end };
    for &c in &n.children {
        let child = tree.node(c);
        let removed = !kept.contains(&c);
        // New children go before the first existing child that sorts after them.
        let child_rank = if child.ns.as_deref() == Some(NS_A) { rank(&child.local) } else { usize::MAX };
        while let Some((_, bytes)) = pending.next_if(|(l, _)| rank(l) < child_rank) {
            out.extend_from_slice(&src[at..child.start]);
            at = child.start;
            out.extend_from_slice(bytes);
        }
        out.extend_from_slice(&src[at..child.start]);
        if !removed {
            out.extend_from_slice(&src[child.start..child.end]);
        }
        at = child.end;
    }
    let close = if n.is_empty_element() { n.end } else { n.close_start };
    out.extend_from_slice(&src[at..close]);
    for (_, bytes) in pending {
        out.extend_from_slice(bytes);
    }
    out.extend_from_slice(format!("</{}>", n.qname).as_bytes());
    Ok(out)
}

/// Prefix bound to DrawingML in this part (`a:` almost always).
pub fn drawing_prefix(tree: &Tree) -> Result<String, Error> {
    tree.nodes
        .iter()
        .find(|n| n.ns.as_deref() == Some(NS_A))
        .map(|n| n.prefix().to_owned())
        .ok_or_else(|| Error::Unsupported("part has no DrawingML element to take its prefix from".into()))
}

/// The prefix the root element declares for namespace `ns`.
pub fn ns_prefix(src: &[u8], tree: &Tree, ns: &str) -> Option<String> {
    let root = tree.node(tree.root);
    let tag = std::str::from_utf8(&src[root.start..root.open_end]).ok()?;
    let at = tag.find(&format!("=\"{ns}\""))?;
    tag[..at].rsplit("xmlns:").next().map(|p| p.trim().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const NS: &str = r#"xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main""#;

    fn apply(xml: &str, change: &Change) -> String {
        let tree = Tree::parse(xml.as_bytes()).unwrap();
        let node = tree.nodes[tree.root].children[0];
        let n = tree.node(node);
        let mut out = xml.as_bytes()[..n.start].to_vec();
        out.extend(rebuild(xml.as_bytes(), &tree, node, change).unwrap());
        out.extend_from_slice(&xml.as_bytes()[n.end..]);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn sets_attributes_and_keeps_the_rest() {
        let xml = format!(r#"<a:p {NS}><a:rPr lang="ko-KR"  b="0" dirty='0'/></a:p>"#);
        let change = Change { attrs: vec![("b", Some("1".into())), ("sz", Some("2400".into())), ("dirty", None)], ..Default::default() };
        assert_eq!(apply(&xml, &change), format!(r#"<a:p {NS}><a:rPr lang="ko-KR" b="1" sz="2400"/></a:p>"#));
    }

    #[test]
    fn replaces_and_inserts_children_in_schema_order() {
        let xml = format!(r#"<a:p {NS}><a:rPr> <a:ln/> <a:noFill/> <a:latin typeface="x"/> </a:rPr></a:p>"#);
        let order = ["ln", "noFill", "solidFill", "effectLst", "latin", "ea"];
        let change = Change { remove: vec!["noFill"], insert: vec![("solidFill", b"<a:solidFill/>".to_vec()), ("ea", b"<a:ea/>".to_vec())], order: &order, ..Default::default() };
        assert_eq!(apply(&xml, &change), format!(r#"<a:p {NS}><a:rPr> <a:ln/>  <a:solidFill/><a:latin typeface="x"/> <a:ea/></a:rPr></a:p>"#));
    }

    #[test]
    fn expands_an_empty_element_when_children_are_added() {
        let xml = format!(r#"<a:p {NS}><a:rPr sz="1000"/></a:p>"#);
        let order = ["solidFill"];
        let change = Change { insert: vec![("solidFill", b"<a:solidFill/>".to_vec())], order: &order, ..Default::default() };
        assert_eq!(apply(&xml, &change), format!(r#"<a:p {NS}><a:rPr sz="1000"><a:solidFill/></a:rPr></a:p>"#));
    }
}
