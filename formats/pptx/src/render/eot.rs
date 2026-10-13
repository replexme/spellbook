//! Embedded fonts: PowerPoint stores them as Embedded OpenType (EOT), whose
//! font data is usually MicroType Express (MTX) compressed. This turns one
//! back into a TrueType font for drawing.
//!
//! Formats: EOT, W3C Member Submission 2008-03-05
//! (https://www.w3.org/Submission/EOT/), and MTX, W3C Member Submission
//! 2008-03-05 (https://www.w3.org/Submission/MTX/), whose LZCOMP and adaptive
//! Huffman decoding follow the spec's sample code (Appendix C). Written from
//! those documents; libeot (MPL 2.0) was read only to cross-check, and no
//! code was taken from it.
//!
//! Only outlines are rebuilt. MTX keeps glyph hinting instructions in its
//! second and third blocks; the renderer draws unhinted outlines, so those
//! blocks are not decoded, glyphs get empty instructions and the hinting
//! tables (cvt, fpgm, prep) and device metrics tables (hdmx, VDMX, LTSH) are
//! left out.

const MAX_OUTPUT: usize = 64 << 20;

/// The TrueType font in an EOT file, or why it can't be read.
pub fn decode(eot: &[u8]) -> Result<Vec<u8>, String> {
    let u32le = |o: usize| eot.get(o..o + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize);
    let (Some(eot_size), Some(data_size), Some(flags)) = (u32le(0), u32le(4), u32le(12)) else { return Err("too short".into()) };
    if eot.get(34..36) != Some(&[0x4C, 0x50]) {
        return Err("not an EOT file".into());
    }
    // The font data is the last part of the file.
    let end = eot_size.min(eot.len());
    let mut data = eot.get(end.checked_sub(data_size).ok_or("bad font data size")?..end).ok_or("bad font data size")?.to_vec();
    if flags & 0x1000_0000 != 0 {
        data.iter_mut().for_each(|b| *b ^= 0x50);
    }
    if flags & 0x4 != 0 { mtx(&data) } else { Ok(data) }
}

/// An MTX font: three LZCOMP blocks. The first is the font in compact table
/// format (CTF); the others hold glyph instructions (unused, see above).
fn mtx(data: &[u8]) -> Result<Vec<u8>, String> {
    let u24 = |o: usize| data.get(o..o + 3).map(|b| (b[0] as usize) << 16 | (b[1] as usize) << 8 | b[2] as usize);
    let (Some(&version), Some(offset2)) = (data.first(), u24(4)) else { return Err("MTX header too short".into()) };
    let block = data.get(10..offset2).ok_or("bad MTX block offset")?;
    ctf(&lzcomp(block, version)?)
}

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
    byte: u8,
    left: u8,
}

impl Bits<'_> {
    fn bit(&mut self) -> Result<bool, String> {
        if self.left == 0 {
            self.byte = *self.data.get(self.pos).ok_or("compressed data ends early")?;
            self.pos += 1;
            self.left = 8;
        }
        self.left -= 1;
        Ok(self.byte >> self.left & 1 == 1)
    }

    fn value(&mut self, bits: u32) -> Result<usize, String> {
        let mut v = 0;
        for _ in 0..bits {
            v = v << 1 | self.bit()? as usize;
        }
        Ok(v)
    }
}

#[derive(Clone, Copy)]
struct Node {
    up: usize,
    left: usize,
    right: usize,
    /// The symbol of a leaf; -1 for an internal node.
    code: i32,
    weight: u64,
}

/// Adaptive Huffman coding (AHUFF in the MTX sample code). Node 1 is the
/// root; nodes are kept in decreasing weight order (the sibling property).
struct Huffman {
    tree: Vec<Node>,
    /// Symbol -> its leaf.
    leaf: Vec<usize>,
}

impl Huffman {
    fn new(range: usize) -> Self {
        let mut tree = vec![Node { up: 0, left: 0, right: 0, code: -1, weight: 1 }; 2 * range];
        tree[0].weight = u64::MAX;
        for i in 2..2 * range {
            tree[i].up = i / 2;
        }
        for i in 1..range {
            tree[i].left = 2 * i;
            tree[i].right = 2 * i + 1;
        }
        for i in 0..range {
            tree[range + i].code = i as i32;
        }
        for i in (1..range).rev() {
            tree[i].weight = tree[2 * i].weight + tree[2 * i + 1].weight;
        }
        let mut h = Self { tree, leaf: (range..2 * range).collect() };
        if range > 256 && range < 512 {
            // The LZCOMP symbol set: favour the first two copy symbols and the
            // one-byte copies (DUP2 twelve times, DUP4 six times).
            h.update(h.leaf[256]);
            h.update(h.leaf[257]);
            for _ in 0..12 {
                h.update(h.leaf[range - 3]);
            }
            for _ in 0..6 {
                h.update(h.leaf[range - 2]);
            }
        } else {
            for _ in 0..2 {
                for i in 0..range {
                    h.update(h.leaf[i]);
                }
            }
        }
        h
    }

    fn swap(&mut self, a: usize, b: usize) {
        let (up_a, up_b) = (self.tree[a].up, self.tree[b].up);
        self.tree.swap(a, b);
        self.tree[a].up = up_a;
        self.tree[b].up = up_b;
        for n in [a, b] {
            let node = self.tree[n];
            if node.code < 0 {
                self.tree[node.left].up = n;
                self.tree[node.right].up = n;
            } else {
                self.leaf[node.code as usize] = n;
            }
        }
    }

    fn update(&mut self, mut a: usize) {
        while a != 1 {
            let w = self.tree[a].weight;
            if self.tree[a - 1].weight == w {
                let mut b = a - 1;
                while self.tree[b].weight == w {
                    b -= 1;
                }
                b += 1;
                if b > 1 {
                    self.swap(a, b);
                    a = b;
                }
            }
            self.tree[a].weight = w + 1;
            a = self.tree[a].up;
        }
        self.tree[1].weight += 1;
    }

    fn read(&mut self, bits: &mut Bits) -> Result<usize, String> {
        let mut a = 1;
        while self.tree[a].code < 0 {
            a = if bits.bit()? { self.tree[a].right } else { self.tree[a].left };
        }
        // The update can move the leaf; its symbol is taken first.
        let symbol = self.tree[a].code as usize;
        self.update(a);
        Ok(symbol)
    }
}

/// LZCOMP decompression (MTX section 3.3).
fn lzcomp(data: &[u8], version: u8) -> Result<Vec<u8>, String> {
    let mut bits = Bits { data, pos: 0, byte: 0, left: 0 };
    let run_length = version != 1 && bits.bit()?;
    let mut dist = Huffman::new(8);
    let mut len = Huffman::new(8);
    let out_len = bits.value(24)?;
    // Distance ranges: enough 3-bit groups to reach any byte of the output.
    let mut ranges = 1;
    while 1 << (3 * ranges) < out_len {
        ranges += 1;
    }
    let dup2 = 256 + 8 * ranges;
    let mut symbols = Huffman::new(dup2 + 3);

    // The window starts with fixed bytes so early data can use copies.
    let mut window = Vec::with_capacity(7168 + out_len);
    for k in 0..32u8 {
        for j in 0..96u8 {
            window.extend([k, j]);
        }
    }
    for j in 0..=255u8 {
        window.extend([j; 4]);
    }
    let start = window.len();
    while window.len() - start < out_len {
        let s = symbols.read(&mut bits)?;
        if s < 256 {
            window.push(s as u8);
        } else if s >= dup2 {
            let back = 2 * (s - dup2 + 1);
            window.push(window[window.len() - back]);
        } else {
            let mut code = s - 256;
            let distance_symbols = code / 8 + 1;
            code %= 8;
            let mut length = 0;
            loop {
                length = length << 2 | (code & 3);
                if code & 4 == 0 {
                    break;
                }
                code = len.read(&mut bits)?;
            }
            length += 2;
            let mut distance = 0;
            for _ in 0..distance_symbols {
                distance = distance << 3 | dist.read(&mut bits)?;
            }
            distance += 1;
            if distance >= 512 {
                length += 1;
            }
            let from = (window.len() + 1).checked_sub(distance + length).ok_or("copy before the start")?;
            if window.len() - start + length > out_len {
                return Err("copy past the end".into());
            }
            for i in 0..length {
                window.push(window[from + i]);
            }
        }
    }
    let out = window.split_off(start);
    if !run_length {
        return Ok(out);
    }
    // Run-length layer: the first byte is the escape; escape, 0 is the escape
    // byte itself; escape, n, b is n copies of b.
    let mut res = Vec::with_capacity(out.len());
    let mut it = out.iter().copied();
    let escape = it.next().ok_or("empty run-length data")?;
    while let Some(b) = it.next() {
        if b != escape {
            res.push(b);
            continue;
        }
        match it.next().ok_or("run-length data ends early")? {
            0 => res.push(escape),
            n => {
                let v = it.next().ok_or("run-length data ends early")?;
                res.extend(std::iter::repeat_n(v, n as usize));
            }
        }
        if res.len() > MAX_OUTPUT {
            return Err("font too large".into());
        }
    }
    Ok(res)
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn bytes(&mut self, n: usize) -> Result<&[u8], String> {
        let b = self.data.get(self.pos..self.pos + n).ok_or("glyph data ends early")?;
        self.pos += n;
        Ok(b)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.bytes(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        let b = self.bytes(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }
    fn i16(&mut self) -> Result<i16, String> {
        Ok(self.u16()? as i16)
    }
    /// 255UShort (MTX 6.1.1).
    fn u255(&mut self) -> Result<u16, String> {
        Ok(match self.u8()? {
            253 => self.u16()?,
            254 => 506 + self.u8()? as u16,
            255 => 253 + self.u8()? as u16,
            c => c as u16,
        })
    }
}

fn be16(data: &[u8], at: usize) -> Option<u16> {
    data.get(at..at + 2).map(|b| u16::from_be_bytes([b[0], b[1]]))
}

fn be32(data: &[u8], at: usize) -> Option<u32> {
    data.get(at..at + 4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}

/// Compact table format -> TrueType: the tables as stored, except glyf
/// (decoded), loca (rebuilt) and the dropped hinting tables.
fn ctf(data: &[u8]) -> Result<Vec<u8>, String> {
    let count = be16(data, 4).ok_or("no table directory")? as usize;
    let mut tables: Vec<([u8; 4], Vec<u8>)> = Vec::new();
    let mut glyf_at = None;
    for i in 0..count {
        let rec = 12 + 16 * i;
        let tag: [u8; 4] = data.get(rec..rec + 4).ok_or("table directory ends early")?.try_into().unwrap();
        let (Some(offset), Some(length)) = (be32(data, rec + 8), be32(data, rec + 12)) else { return Err("table directory ends early".into()) };
        match &tag {
            b"loca" | b"cvt " | b"fpgm" | b"prep" | b"hdmx" | b"VDMX" | b"LTSH" => {}
            b"glyf" => glyf_at = Some(offset as usize),
            _ => tables.push((tag, data.get(offset as usize..(offset + length) as usize).ok_or("table outside the data")?.to_vec())),
        }
    }
    let table = |t: &[u8; 4]| tables.iter().position(|(tag, _)| tag == t);
    let (Some(head), Some(maxp)) = (table(b"head"), table(b"maxp")) else { return Err("no head or maxp table".into()) };
    if let Some(at) = glyf_at {
        let glyphs = be16(&tables[maxp].1, 4).ok_or("bad maxp table")? as usize;
        let (glyf, loca) = glyf(data, at, glyphs)?;
        tables.push((*b"glyf", glyf));
        tables.push((*b"loca", loca));
        // Long offsets in the rebuilt loca; the checksum adjustment is recomputed.
        let head = &mut tables[head].1;
        if head.len() < 54 {
            return Err("bad head table".into());
        }
        head[50..52].copy_from_slice(&1u16.to_be_bytes());
    }
    Ok(sfnt(&be32(data, 0).unwrap_or(0x10000).to_be_bytes(), tables))
}

/// The glyf and (long) loca tables from the CTF glyph records at `at`.
fn glyf(data: &[u8], at: usize, glyphs: usize) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut r = Reader { data, pos: at };
    let mut glyf = Vec::new();
    let mut loca = Vec::with_capacity(4 * (glyphs + 1));
    loca.extend(0u32.to_be_bytes());
    for _ in 0..glyphs {
        glyph(&mut r, &mut glyf)?;
        while glyf.len() % 4 != 0 {
            glyf.push(0);
        }
        if glyf.len() > MAX_OUTPUT {
            return Err("font too large".into());
        }
        loca.extend((glyf.len() as u32).to_be_bytes());
    }
    Ok((glyf, loca))
}

fn put16(out: &mut Vec<u8>, v: i32) {
    out.extend((v as u16).to_be_bytes());
}

/// One CTF glyph record (MTX 5.8) as a TrueType glyph with no instructions.
fn glyph(r: &mut Reader, out: &mut Vec<u8>) -> Result<(), String> {
    let mut contours = r.i16()?;
    if contours < 0 {
        return composite(r, out);
    }
    let mut bbox = None;
    if contours == 0x7FFF {
        contours = r.i16()?;
        bbox = Some([r.i16()?, r.i16()?, r.i16()?, r.i16()?]);
    }
    if contours <= 0 {
        return Ok(());
    }
    let mut ends = Vec::with_capacity(contours as usize);
    let mut points = 0usize;
    for i in 0..contours {
        points += r.u255()? as usize + usize::from(i == 0);
        ends.push(points - 1);
    }
    let flags = r.bytes(points)?.to_vec();
    let (mut x, mut y) = (0i32, 0i32);
    let mut deltas = Vec::with_capacity(points);
    let (mut lo, mut hi) = ((i32::MAX, i32::MAX), (i32::MIN, i32::MIN));
    for &f in &flags {
        let (dx, dy) = triplet(f, r)?;
        x += dx;
        y += dy;
        lo = (lo.0.min(x), lo.1.min(y));
        hi = (hi.0.max(x), hi.1.max(y));
        deltas.push((dx, dy, f & 0x80 == 0));
    }
    // Instructions: the counts are read past; the bytes live in the unused blocks.
    r.u255()?;
    r.u255()?;
    put16(out, contours as i32);
    let bbox = bbox.map(|b| b.map(i32::from)).unwrap_or([lo.0, lo.1, hi.0, hi.1]);
    for v in bbox {
        put16(out, v);
    }
    for e in ends {
        put16(out, e as i32);
    }
    put16(out, 0);
    for &(dx, dy, on) in &deltas {
        let axis = |d: i32, short: u8, same: u8| match d {
            0 => same,
            -255..=255 => short | if d > 0 { same } else { 0 },
            _ => 0,
        };
        out.push(u8::from(on) | axis(dx, 0x02, 0x10) | axis(dy, 0x04, 0x20));
    }
    for pick in [0, 1] {
        for &(dx, dy, _) in &deltas {
            let d = if pick == 0 { dx } else { dy };
            match d {
                0 => {}
                -255..=255 => out.push(d.unsigned_abs() as u8),
                _ => put16(out, d),
            }
        }
    }
    Ok(())
}

/// A coordinate triplet (MTX 5.11): the flag byte's low 7 bits choose how
/// many bytes follow and how they split into dx and dy.
fn triplet(flag: u8, r: &mut Reader) -> Result<(i32, i32), String> {
    let b0 = (flag & 0x7F) as i32;
    let sign = |f: i32, v: i32| if f & 1 == 1 { v } else { -v };
    Ok(match b0 {
        0..=9 => (0, sign(b0, ((b0 & 14) << 7) + r.u8()? as i32)),
        10..=19 => (sign(b0, (((b0 - 10) & 14) << 7) + r.u8()? as i32), 0),
        20..=83 => {
            let (b, b1) = (b0 - 20, r.u8()? as i32);
            (sign(b0, 1 + (b & 0x30) + (b1 >> 4)), sign(b0 >> 1, 1 + ((b & 0x0C) << 2) + (b1 & 0x0F)))
        }
        84..=119 => {
            let b = b0 - 84;
            let (b1, b2) = (r.u8()? as i32, r.u8()? as i32);
            (sign(b0, 1 + ((b / 12) << 8) + b1), sign(b0 >> 1, 1 + (((b % 12) >> 2) << 8) + b2))
        }
        120..=123 => {
            let (b1, b2, b3) = (r.u8()? as i32, r.u8()? as i32, r.u8()? as i32);
            (sign(b0, (b1 << 4) + (b2 >> 4)), sign(b0 >> 1, ((b2 & 0x0F) << 8) + b3))
        }
        _ => {
            let (x, y) = (r.u16()? as i32, r.u16()? as i32);
            (sign(b0, x), sign(b0 >> 1, y))
        }
    })
}

/// A composite glyph (MTX 5.10): the TrueType record after its bounding box,
/// with the instruction counts in place of instructions.
fn composite(r: &mut Reader, out: &mut Vec<u8>) -> Result<(), String> {
    const ARGS_ARE_WORDS: u16 = 0x1;
    const HAVE_SCALE: u16 = 0x8;
    const MORE_COMPONENTS: u16 = 0x20;
    const HAVE_XY_SCALE: u16 = 0x40;
    const HAVE_2X2: u16 = 0x80;
    const HAVE_INSTRUCTIONS: u16 = 0x100;
    put16(out, -1);
    out.extend_from_slice(r.bytes(8)?);
    loop {
        let flags = r.u16()?;
        out.extend((flags & !HAVE_INSTRUCTIONS).to_be_bytes());
        let args = if flags & ARGS_ARE_WORDS != 0 { 4 } else { 2 };
        let transform = if flags & HAVE_2X2 != 0 {
            8
        } else if flags & HAVE_XY_SCALE != 0 {
            4
        } else if flags & HAVE_SCALE != 0 {
            2
        } else {
            0
        };
        out.extend_from_slice(r.bytes(2 + args + transform)?);
        if flags & MORE_COMPONENTS == 0 {
            if flags & HAVE_INSTRUCTIONS != 0 {
                r.u255()?;
                r.u255()?;
            }
            return Ok(());
        }
    }
}

/// An sfnt file from its tables (sorted by tag, 4-byte aligned, with checksums).
fn sfnt(version: &[u8; 4], mut tables: Vec<([u8; 4], Vec<u8>)>) -> Vec<u8> {
    tables.sort_by_key(|(t, _)| *t);
    let n = tables.len();
    let mut pow = 1;
    while pow * 2 <= n {
        pow *= 2;
    }
    let mut out = Vec::new();
    out.extend_from_slice(version);
    for v in [n, pow * 16, pow.trailing_zeros() as usize, n * 16 - pow * 16] {
        out.extend((v as u16).to_be_bytes());
    }
    let checksum = |b: &[u8]| b.chunks(4).fold(0u32, |s, c| s.wrapping_add(u32::from_be_bytes([c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0), *c.get(3).unwrap_or(&0)])));
    let mut offset = 12 + 16 * n;
    for (tag, body) in &tables {
        out.extend_from_slice(tag);
        out.extend(checksum(body).to_be_bytes());
        out.extend((offset as u32).to_be_bytes());
        out.extend((body.len() as u32).to_be_bytes());
        offset += body.len().div_ceil(4) * 4;
    }
    let mut head_at = None;
    for (tag, body) in &tables {
        if tag == b"head" {
            head_at = Some(out.len());
        }
        out.extend_from_slice(body);
        out.resize(out.len().div_ceil(4) * 4, 0);
    }
    if let Some(h) = head_at.filter(|h| out.len() >= h + 12) {
        out[h + 8..h + 12].fill(0);
        let adjust = 0xB1B0_AFBAu32.wrapping_sub(checksum(&out));
        out[h + 8..h + 12].copy_from_slice(&adjust.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn triplets_follow_the_spec_table() {
        // (flag, following bytes) -> (dx, dy), rows from MTX 5.11.
        let cases: &[(u8, &[u8], (i32, i32))] = &[
            (0, &[5], (0, -5)),
            (3, &[5], (0, 261)),
            (10, &[7], (-7, 0)),
            (19, &[0], (1024, 0)),
            (20, &[0x23], (-3, -4)),
            (23, &[0x00], (1, 1)),
            (24, &[0x00], (-1, -17)),
            (84, &[2, 3], (-3, -4)),
            (96, &[0, 0], (-257, -1)),
            (120, &[0x12, 0x34, 0x56], (-0x123, -0x456)),
            (127, &[0x01, 0x00, 0x02, 0x00], (256, 512)),
            (0x80 | 1, &[5], (0, 5)),
        ];
        for (flag, bytes, want) in cases {
            let mut r = Reader { data: bytes, pos: 0 };
            assert_eq!(triplet(*flag, &mut r).unwrap(), *want, "flag {flag}");
            assert_eq!(r.pos, bytes.len());
        }
    }

    #[test]
    fn non_eot_data_is_refused() {
        assert!(decode(b"not a font").is_err());
        assert!(decode(&[0u8; 100]).is_err());
    }

    /// Writes bits most significant first, as LZCOMP reads them.
    #[derive(Default)]
    struct BitWriter {
        out: Vec<u8>,
        acc: u8,
        n: u8,
    }

    impl BitWriter {
        fn bit(&mut self, b: bool) {
            self.acc = self.acc << 1 | b as u8;
            self.n += 1;
            if self.n == 8 {
                self.out.push(self.acc);
                (self.acc, self.n) = (0, 0);
            }
        }
        fn value(&mut self, v: usize, bits: u32) {
            for i in (0..bits).rev() {
                self.bit(v >> i & 1 == 1);
            }
        }
        fn finish(mut self) -> Vec<u8> {
            while self.n != 0 {
                self.bit(false);
            }
            self.out
        }
    }

    impl Huffman {
        fn write(&mut self, symbol: usize, w: &mut BitWriter) {
            let leaf = self.leaf[symbol];
            let mut path = Vec::new();
            let mut a = leaf;
            while a != 1 {
                let up = self.tree[a].up;
                path.push(self.tree[up].right == a);
                a = up;
            }
            path.iter().rev().for_each(|b| w.bit(*b));
            self.update(leaf);
        }
    }

    /// LZCOMP compression with literals, copies (distance under 512) and
    /// one-byte copies from two back: the decoder's every symbol kind.
    fn lzcomp_encode(data: &[u8]) -> Vec<u8> {
        let mut w = BitWriter::default();
        w.bit(false);
        let (mut dist, mut len) = (Huffman::new(8), Huffman::new(8));
        w.value(data.len(), 24);
        let mut ranges = 1;
        while 1 << (3 * ranges) < data.len() {
            ranges += 1;
        }
        let dup2 = 256 + 8 * ranges;
        let mut symbols = Huffman::new(dup2 + 3);
        let mut i = 0;
        while i < data.len() {
            // The longest earlier copy ending at least one byte back.
            let mut best = (0, 0);
            for d in 1..512.min(i + 1) {
                let mut l = 0;
                // A copy of length l reads data[i + 1 - d - l .. i + 1 - d].
                for cand in (2..=17).rev() {
                    if i + cand <= data.len() && i + 1 >= d + cand && data[i + 1 - d - cand..i + 1 - d] == data[i..i + cand] {
                        l = cand;
                        break;
                    }
                }
                if l > best.0 {
                    best = (l, d);
                }
            }
            if best.0 >= 3 {
                let (l, d) = best;
                let v = l - 2;
                let groups = if v >= 4 { 2 } else { 1 };
                let dv = d - 1;
                let nd = if dv >= 64 { 3 } else if dv >= 8 { 2 } else { 1 };
                let first = if groups == 2 { (v >> 2 & 3) | 4 } else { v & 3 };
                symbols.write(256 + (nd - 1) * 8 + first, &mut w);
                if groups == 2 {
                    len.write(v & 3, &mut w);
                }
                for k in (0..nd).rev() {
                    dist.write(dv >> (3 * k) & 7, &mut w);
                }
                i += l;
            } else if i >= 2 && data[i] == data[i - 2] {
                symbols.write(dup2, &mut w);
                i += 1;
            } else {
                symbols.write(data[i] as usize, &mut w);
                i += 1;
            }
        }
        w.finish()
    }

    #[test]
    fn lzcomp_decodes_literals_copies_and_short_copies() {
        let data: Vec<u8> = b"abababab hello hello hello, compact table format; compact table format!".iter().copied().chain((0..300).map(|i| (i % 7) as u8)).collect();
        assert_eq!(lzcomp(&lzcomp_encode(&data), 3).unwrap(), data);
    }

    /// An EOT file holding `ctf` MTX compressed (blocks 2 and 3 empty).
    fn mtx_eot(ctf: &[u8]) -> Vec<u8> {
        let block = lzcomp_encode(ctf);
        let mut mtx = vec![3, 0, 0, 0];
        let end = (10 + block.len()) as u32;
        for _ in 0..2 {
            mtx.extend(&end.to_be_bytes()[1..]);
        }
        mtx.extend(block);
        let mut eot = vec![0u8; 82];
        let size = (eot.len() + mtx.len()) as u32;
        eot[0..4].copy_from_slice(&size.to_le_bytes());
        eot[4..8].copy_from_slice(&(mtx.len() as u32).to_le_bytes());
        eot[8..12].copy_from_slice(&0x0002_0001u32.to_le_bytes());
        eot[12..16].copy_from_slice(&4u32.to_le_bytes());
        eot[34..36].copy_from_slice(&0x504Cu16.to_le_bytes());
        eot.extend(mtx);
        eot
    }

    /// Compact table format: an empty glyph, a square (one long and three
    /// short triplets) and a composite of the square moved by (50, 10),
    /// with a hinting table that is dropped.
    fn ctf() -> Vec<u8> {
        let mut head = vec![0u8; 54];
        head[12..16].copy_from_slice(&0x5F0F_3CF5u32.to_be_bytes());
        head[18..20].copy_from_slice(&1000u16.to_be_bytes());
        let mut maxp = 0x0000_5000u32.to_be_bytes().to_vec();
        maxp.extend(3u16.to_be_bytes());
        let mut hhea = vec![0u8; 36];
        hhea[0..4].copy_from_slice(&0x0001_0000u32.to_be_bytes());
        hhea[34..36].copy_from_slice(&3u16.to_be_bytes());
        // Advance 600; left side bearings equal to the glyphs' left edges.
        let hmtx: Vec<u8> = [0u8, 100, 150].iter().flat_map(|&lsb| [0x02, 0x58, 0, lsb]).collect();
        let mut glyf = Vec::new();
        glyf.extend(0i16.to_be_bytes());
        glyf.extend(1i16.to_be_bytes());
        glyf.push(3); // end point of the contour (255UShort)
        glyf.extend([125, 13, 5, 12]); // on-curve flags
        glyf.extend([0, 100, 0, 0, 144, 188, 144]); // (100,0) long form, (400,0), (0,700), (-400,0)
        glyf.extend([0, 0]); // no push data, no instructions
        glyf.extend((-1i16).to_be_bytes());
        for v in [150i16, 10, 550, 710] {
            glyf.extend(v.to_be_bytes());
        }
        glyf.extend(0x0103u16.to_be_bytes()); // word args, xy values, instructions
        glyf.extend(1u16.to_be_bytes());
        glyf.extend(50i16.to_be_bytes());
        glyf.extend(10i16.to_be_bytes());
        glyf.extend([0, 0]);
        let tables: Vec<(&[u8; 4], Vec<u8>)> =
            vec![(b"cvt ", vec![0, 1, 5]), (b"glyf", glyf), (b"head", head), (b"hhea", hhea), (b"hmtx", hmtx), (b"loca", vec![]), (b"maxp", maxp)];
        let mut out = 0x0001_0000u32.to_be_bytes().to_vec();
        out.extend((tables.len() as u16).to_be_bytes());
        out.extend([0; 6]);
        let mut offset = 12 + 16 * tables.len();
        for (tag, body) in &tables {
            out.extend(*tag);
            out.extend([0; 4]);
            let at = if body.is_empty() { 0 } else { offset };
            out.extend((at as u32).to_be_bytes());
            out.extend((body.len() as u32).to_be_bytes());
            offset += body.len();
        }
        tables.iter().for_each(|(_, b)| out.extend(b));
        out
    }

    struct Points(Vec<(f32, f32)>);

    impl skrifa::outline::OutlinePen for Points {
        fn move_to(&mut self, x: f32, y: f32) {
            self.0.push((x, y));
        }
        fn line_to(&mut self, x: f32, y: f32) {
            self.0.push((x, y));
        }
        fn quad_to(&mut self, _: f32, _: f32, x: f32, y: f32) {
            self.0.push((x, y));
        }
        fn curve_to(&mut self, _: f32, _: f32, _: f32, _: f32, x: f32, y: f32) {
            self.0.push((x, y));
        }
        fn close(&mut self) {}
    }

    #[test]
    fn an_mtx_font_decodes_to_its_outlines() {
        use skrifa::outline::DrawSettings;
        use skrifa::raw::TableProvider;
        use skrifa::{GlyphId, MetadataProvider, Tag};
        let ttf = decode(&mtx_eot(&ctf())).unwrap();
        let font = skrifa::FontRef::new(&ttf).unwrap();
        assert!(font.table_data(Tag::new(b"cvt ")).is_none(), "hinting dropped");
        assert_eq!(font.head().unwrap().index_to_loc_format(), 1);
        let points = |gid: u32| {
            let mut pen = Points(Vec::new());
            let glyph = font.outline_glyphs().get(GlyphId::new(gid)).unwrap();
            glyph.draw(DrawSettings::unhinted(skrifa::instance::Size::unscaled(), skrifa::instance::LocationRef::default()), &mut pen).unwrap();
            let mut p = pen.0;
            p.sort_by(|a, b| a.partial_cmp(b).unwrap());
            p.dedup();
            p
        };
        assert!(points(0).is_empty());
        assert_eq!(points(1), vec![(100.0, 0.0), (100.0, 700.0), (500.0, 0.0), (500.0, 700.0)]);
        assert_eq!(points(2), vec![(150.0, 10.0), (150.0, 710.0), (550.0, 10.0), (550.0, 710.0)]);
    }
}
