//! Read-only XML element tree that remembers source byte ranges.
//!
//! Edits are expressed as byte-range replacements on the original part, so
//! everything outside the edited element keeps its exact bytes: prefixes,
//! attribute order, whitespace and unknown extensions.

use quick_xml::events::Event;
use quick_xml::name::ResolveResult;
use quick_xml::NsReader;

use crate::Error;

#[derive(Debug, Clone)]
pub struct Attr {
    pub ns: Option<String>,
    pub local: String,
    pub value: String,
}

#[derive(Debug, Clone)]
pub struct Node {
    pub ns: Option<String>,
    pub local: String,
    /// Qualified name as written in the source, e.g. `a:t`.
    pub qname: String,
    pub attrs: Vec<Attr>,
    /// Start of the start tag (`<`).
    pub start: usize,
    /// End of the start tag (after `>`); equals `end` for empty elements.
    pub open_end: usize,
    /// Start of the end tag; equals `end` for empty elements.
    pub close_start: usize,
    /// End of the element (after `>`).
    pub end: usize,
    pub parent: Option<usize>,
    pub children: Vec<usize>,
}

impl Node {
    pub fn is(&self, ns: &str, local: &str) -> bool {
        self.ns.as_deref() == Some(ns) && self.local == local
    }

    pub fn attr(&self, local: &str) -> Option<&str> {
        self.attrs.iter().find(|a| a.ns.is_none() && a.local == local).map(|a| a.value.as_str())
    }

    pub fn attr_ns(&self, ns: &str, local: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|a| a.ns.as_deref() == Some(ns) && a.local == local)
            .map(|a| a.value.as_str())
    }

    /// Namespace prefix including the colon, e.g. `a:`; empty if unprefixed.
    pub fn prefix(&self) -> &str {
        match self.qname.find(':') {
            Some(i) => &self.qname[..=i],
            None => "",
        }
    }

    pub fn is_empty_element(&self) -> bool {
        self.open_end == self.end
    }
}

#[derive(Debug, Clone)]
pub struct Tree {
    pub nodes: Vec<Node>,
    pub root: usize,
}

fn ns_of(r: ResolveResult) -> Option<String> {
    match r {
        ResolveResult::Bound(ns) => Some(String::from_utf8_lossy(ns.as_ref()).into_owned()),
        _ => None,
    }
}

impl Tree {
    pub fn parse(src: &[u8]) -> Result<Self, Error> {
        let mut reader = NsReader::from_reader(src);
        reader.config_mut().trim_text(false);
        let mut nodes: Vec<Node> = Vec::new();
        let mut stack: Vec<usize> = Vec::new();
        let mut root = None;
        loop {
            let before = reader.buffer_position() as usize;
            let event = reader
                .read_event()
                .map_err(|e| Error::Xml(format!("at byte {before}: {e}")))?;
            let after = reader.buffer_position() as usize;
            match event {
                Event::Start(ref e) | Event::Empty(ref e) => {
                    let is_empty = matches!(event, Event::Empty(_));
                    let (ns, local) = reader.resolve_element(e.name());
                    let mut attrs = Vec::new();
                    for attr in e.attributes().with_checks(false) {
                        let attr = attr.map_err(|err| Error::Xml(err.to_string()))?;
                        let (ans, alocal) = reader.resolve_attribute(attr.key);
                        let value = attr
                            .decode_and_unescape_value(reader.decoder())
                            .map_err(|err| Error::Xml(err.to_string()))?
                            .into_owned();
                        attrs.push(Attr {
                            ns: ns_of(ans),
                            local: String::from_utf8_lossy(alocal.as_ref()).into_owned(),
                            value,
                        });
                    }
                    let index = nodes.len();
                    let parent = stack.last().copied();
                    nodes.push(Node {
                        ns: ns_of(ns),
                        local: String::from_utf8_lossy(local.as_ref()).into_owned(),
                        qname: String::from_utf8_lossy(e.name().as_ref()).into_owned(),
                        attrs,
                        start: before,
                        open_end: after,
                        close_start: after,
                        end: after,
                        parent,
                        children: Vec::new(),
                    });
                    match parent {
                        Some(p) => nodes[p].children.push(index),
                        None => root = Some(index),
                    }
                    if !is_empty {
                        stack.push(index);
                    }
                }
                Event::End(_) => {
                    let index = stack.pop().ok_or_else(|| Error::Xml("unbalanced end tag".into()))?;
                    nodes[index].close_start = before;
                    nodes[index].end = after;
                }
                Event::Eof => break,
                _ => {}
            }
        }
        if !stack.is_empty() {
            return Err(Error::Xml("unclosed element".into()));
        }
        let root = root.ok_or_else(|| Error::Xml("no root element".into()))?;
        Ok(Self { nodes, root })
    }

    pub fn node(&self, i: usize) -> &Node {
        &self.nodes[i]
    }

    pub fn child(&self, parent: usize, ns: &str, local: &str) -> Option<usize> {
        self.nodes[parent].children.iter().copied().find(|&c| self.nodes[c].is(ns, local))
    }

    pub fn children_named<'a>(&'a self, parent: usize, ns: &'a str, local: &'a str) -> impl Iterator<Item = usize> + 'a {
        self.nodes[parent].children.iter().copied().filter(move |&c| self.nodes[c].is(ns, local))
    }

    /// Follows a path of child element names from `start`.
    pub fn path(&self, start: usize, steps: &[(&str, &str)]) -> Option<usize> {
        steps.iter().try_fold(start, |at, (ns, local)| self.child(at, ns, local))
    }

    /// Unescaped character content between the tags of a leaf element.
    pub fn text(&self, src: &[u8], i: usize) -> Result<String, Error> {
        let n = &self.nodes[i];
        let raw = std::str::from_utf8(&src[n.open_end..n.close_start]).map_err(|e| Error::Xml(e.to_string()))?;
        // XML 1.0 end-of-line handling: a literal CR LF or lone CR reads as
        // LF. An escaped `&#13;` stays a CR.
        let raw = if raw.contains('\r') { std::borrow::Cow::Owned(raw.replace("\r\n", "\n").replace('\r', "\n")) } else { std::borrow::Cow::Borrowed(raw) };
        quick_xml::escape::unescape(&raw)
            .map(|c| c.into_owned())
            .map_err(|e| Error::Xml(e.to_string()))
    }
}

/// Escapes character content for an element body.
pub fn escape_text(text: &str) -> String {
    quick_xml::escape::partial_escape(text).into_owned()
}

/// Applies non-overlapping byte-range replacements.
pub fn splice(src: &[u8], mut edits: Vec<(std::ops::Range<usize>, Vec<u8>)>) -> Result<Vec<u8>, Error> {
    edits.sort_by_key(|(r, _)| r.start);
    let mut out = Vec::with_capacity(src.len());
    let mut at = 0;
    for (range, bytes) in edits {
        if range.start < at || range.end > src.len() || range.start > range.end {
            return Err(Error::Xml("overlapping or invalid edit ranges".into()));
        }
        out.extend_from_slice(&src[at..range.start]);
        out.extend_from_slice(&bytes);
        at = range.end;
    }
    out.extend_from_slice(&src[at..]);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_follows_xml_end_of_line_handling() {
        let src = "<t xmlns=\"urn:x\"><a>one\r\ntwo\rthree&#13;four</a></t>".as_bytes();
        let tree = Tree::parse(src).unwrap();
        let a = tree.child(tree.root, "urn:x", "a").unwrap();
        assert_eq!(tree.text(src, a).unwrap(), "one\ntwo\nthree\rfour");
    }
}
