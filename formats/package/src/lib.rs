//! Byte-preserving ZIP package (PPTX and IDML).
//!
//! The original file bytes are kept. Saving copies every untouched entry's
//! local header and compressed data verbatim and only writes new records for
//! parts that were changed or added. A save with no changes returns the
//! original bytes. New records never use data descriptors or ZIP64.

pub mod xml;

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::sync::Arc;

use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;

/// What can go wrong reading or writing a package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// The ZIP structure is broken or unreadable.
    Package(String),
    /// A ZIP feature this package does not handle (encryption, ZIP64, an unknown method).
    Unsupported(String),
    /// A named part is not in the package.
    MissingPart(String),
    /// A part's XML is malformed, or an edit of it is.
    Xml(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for Error {}

const LOCAL_SIG: u32 = 0x0403_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
const DESCRIPTOR_SIG: u32 = 0x0807_4b50;
/// Largest part we inflate; guards against decompression bombs.
const MAX_PART_SIZE: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone)]
struct Entry {
    name: String,
    /// Original central directory record, copied when the entry is untouched.
    central: Vec<u8>,
    local_start: usize,
    /// End of the local record including any data descriptor.
    local_end: usize,
    data_start: usize,
    method: u16,
    flags: u16,
    crc: u32,
    compressed_size: u32,
    uncompressed_size: u32,
    mod_time: u16,
    mod_date: u16,
}

#[derive(Debug)]
struct Original {
    bytes: Vec<u8>,
    entries: Vec<Entry>,
    comment: Vec<u8>,
}

/// A package with copy-on-write part overrides. Cloning is cheap.
#[derive(Debug, Clone)]
pub struct Package {
    original: Arc<Original>,
    overrides: BTreeMap<String, Arc<Vec<u8>>>,
    /// Original parts deleted since opening.
    removed: BTreeSet<String>,
}

fn u16_at(b: &[u8], at: usize) -> Result<u16, Error> {
    b.get(at..at + 2)
        .map(|s| u16::from_le_bytes([s[0], s[1]]))
        .ok_or_else(|| Error::Package("truncated record".into()))
}

fn u32_at(b: &[u8], at: usize) -> Result<u32, Error> {
    b.get(at..at + 4)
        .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
        .ok_or_else(|| Error::Package("truncated record".into()))
}

impl Package {
    pub fn open(bytes: Vec<u8>) -> Result<Self, Error> {
        let eocd = find_eocd(&bytes)?;
        let disk_entries = u16_at(&bytes, eocd + 10)? as usize;
        let cd_size = u32_at(&bytes, eocd + 12)? as usize;
        let cd_offset = u32_at(&bytes, eocd + 16)? as usize;
        let comment_len = u16_at(&bytes, eocd + 20)? as usize;
        if disk_entries == 0xFFFF || cd_offset == 0xFFFF_FFFF {
            return Err(Error::Unsupported("ZIP64 packages".into()));
        }
        let comment = bytes
            .get(eocd + 22..eocd + 22 + comment_len)
            .ok_or_else(|| Error::Package("truncated comment".into()))?
            .to_vec();
        if cd_offset + cd_size > eocd {
            return Err(Error::Package("central directory overlaps end record".into()));
        }
        let mut entries = Vec::with_capacity(disk_entries);
        let mut at = cd_offset;
        for _ in 0..disk_entries {
            if u32_at(&bytes, at)? != CENTRAL_SIG {
                return Err(Error::Package("bad central directory signature".into()));
            }
            let flags = u16_at(&bytes, at + 8)?;
            let method = u16_at(&bytes, at + 10)?;
            let mod_time = u16_at(&bytes, at + 12)?;
            let mod_date = u16_at(&bytes, at + 14)?;
            let crc = u32_at(&bytes, at + 16)?;
            let compressed_size = u32_at(&bytes, at + 20)?;
            let uncompressed_size = u32_at(&bytes, at + 24)?;
            let name_len = u16_at(&bytes, at + 28)? as usize;
            let extra_len = u16_at(&bytes, at + 30)? as usize;
            let comment_len = u16_at(&bytes, at + 32)? as usize;
            let local_start = u32_at(&bytes, at + 42)? as usize;
            if compressed_size == 0xFFFF_FFFF || uncompressed_size == 0xFFFF_FFFF || local_start == 0xFFFF_FFFF {
                return Err(Error::Unsupported("ZIP64 entries".into()));
            }
            if flags & 0x1 != 0 {
                return Err(Error::Unsupported("encrypted entries".into()));
            }
            let record_end = at + 46 + name_len + extra_len + comment_len;
            let name_bytes = bytes
                .get(at + 46..at + 46 + name_len)
                .ok_or_else(|| Error::Package("truncated name".into()))?;
            let name = String::from_utf8(name_bytes.to_vec())
                .map_err(|_| Error::Unsupported("non-UTF-8 part name".into()))?;
            let central = bytes
                .get(at..record_end)
                .ok_or_else(|| Error::Package("truncated central record".into()))?
                .to_vec();
            if u32_at(&bytes, local_start)? != LOCAL_SIG {
                return Err(Error::Package(format!("bad local header for {name}")));
            }
            let local_name_len = u16_at(&bytes, local_start + 26)? as usize;
            let local_extra_len = u16_at(&bytes, local_start + 28)? as usize;
            let data_start = local_start + 30 + local_name_len + local_extra_len;
            let mut local_end = data_start + compressed_size as usize;
            if flags & 0x8 != 0 {
                // Data descriptor: optional signature, CRC, two 32-bit sizes.
                local_end += if u32_at(&bytes, local_end)? == DESCRIPTOR_SIG { 16 } else { 12 };
            }
            if local_end > bytes.len() {
                return Err(Error::Package(format!("entry {name} runs past end of file")));
            }
            entries.push(Entry {
                name,
                central,
                local_start,
                local_end,
                data_start,
                method,
                flags,
                crc,
                compressed_size,
                uncompressed_size,
                mod_time,
                mod_date,
            });
            at = record_end;
        }
        Ok(Self {
            original: Arc::new(Original { bytes, entries, comment }),
            overrides: BTreeMap::new(),
            removed: BTreeSet::new(),
        })
    }

    /// Builds a new package from parts, in the given order.
    pub fn from_parts(parts: &[(&str, &[u8])]) -> Result<Self, Error> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data) in parts {
            write_new_entry(&mut out, &mut central, name, data, 0, 0x21, 20, 0)?;
        }
        let cd_offset = to_u32(out.len())?;
        out.extend_from_slice(&central);
        let count = u16::try_from(parts.len()).map_err(|_| Error::Unsupported("more than 65535 parts".into()))?;
        out.extend_from_slice(&EOCD_SIG.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
        out.extend_from_slice(&to_u32(central.len())?.to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        Self::open(out)
    }

    pub fn part_names(&self) -> impl Iterator<Item = &str> {
        self.original
            .entries
            .iter()
            .map(|e| e.name.as_str())
            .filter(|n| !self.removed.contains(*n))
            .chain(self.overrides.keys().filter(|k| !self.has_original(k)).map(|k| k.as_str()))
    }

    /// The uncompressed size a part declares (its current bytes for a changed part), read
    /// without decompressing it: for checking a package before reading it.
    pub fn declared_size(&self, name: &str) -> Option<u64> {
        if let Some(b) = self.overrides.get(name) {
            return Some(b.len() as u64);
        }
        if self.removed.contains(name) {
            return None;
        }
        self.original.entries.iter().find(|e| e.name == name).map(|e| e.uncompressed_size as u64)
    }

    fn has_original(&self, name: &str) -> bool {
        self.original.entries.iter().any(|e| e.name == name)
    }

    pub fn contains(&self, name: &str) -> bool {
        self.overrides.contains_key(name) || (self.has_original(name) && !self.removed.contains(name))
    }

    pub fn is_modified(&self) -> bool {
        !self.overrides.is_empty() || !self.removed.is_empty()
    }

    /// Names of parts whose content differs from the opened file (including
    /// added and removed parts).
    pub fn modified_parts(&self) -> Vec<String> {
        let mut out: Vec<String> = self.overrides.keys().cloned().chain(self.removed.iter().cloned()).collect();
        out.sort();
        out
    }

    /// Deletes a part.
    pub fn remove(&mut self, name: &str) -> Result<(), Error> {
        if !self.contains(name) {
            return Err(Error::MissingPart(name.to_owned()));
        }
        self.overrides.remove(name);
        if self.has_original(name) {
            self.removed.insert(name.to_owned());
        }
        Ok(())
    }

    /// Returns the uncompressed bytes of a part.
    pub fn read(&self, name: &str) -> Result<Arc<Vec<u8>>, Error> {
        if let Some(bytes) = self.overrides.get(name) {
            return Ok(bytes.clone());
        }
        if self.removed.contains(name) {
            return Err(Error::MissingPart(name.to_owned()));
        }
        let entry = self
            .original
            .entries
            .iter()
            .find(|e| e.name == name)
            .ok_or_else(|| Error::MissingPart(name.to_owned()))?;
        if entry.uncompressed_size as u64 > MAX_PART_SIZE {
            return Err(Error::Unsupported(format!("part {name} larger than {MAX_PART_SIZE} bytes")));
        }
        let raw = &self.original.bytes[entry.data_start..entry.data_start + entry.compressed_size as usize];
        let data = match entry.method {
            0 => raw.to_vec(),
            8 => {
                let mut out = Vec::with_capacity(entry.uncompressed_size as usize);
                DeflateDecoder::new(raw)
                    .take(MAX_PART_SIZE + 1)
                    .read_to_end(&mut out)
                    .map_err(|e| Error::Package(format!("inflate {name}: {e}")))?;
                out
            }
            m => return Err(Error::Unsupported(format!("compression method {m} in {name}"))),
        };
        if data.len() != entry.uncompressed_size as usize || crc32fast::hash(&data) != entry.crc {
            return Err(Error::Package(format!("checksum mismatch in {name}")));
        }
        Ok(Arc::new(data))
    }

    /// Replaces or adds a part. Writing bytes equal to the original removes
    /// the override, so a revert is again byte-identical.
    pub fn write(&mut self, name: &str, data: Vec<u8>) -> Result<(), Error> {
        if !name.is_ascii() || name.starts_with('/') {
            return Err(Error::Package(format!("invalid part name {name}")));
        }
        self.removed.remove(name);
        if self.has_original(name) && self.read_original(name)?.as_slice() == data.as_slice() {
            self.overrides.remove(name);
        } else {
            self.overrides.insert(name.to_owned(), Arc::new(data));
        }
        Ok(())
    }

    fn read_original(&self, name: &str) -> Result<Arc<Vec<u8>>, Error> {
        Package { original: self.original.clone(), overrides: BTreeMap::new(), removed: BTreeSet::new() }.read(name)
    }

    /// Serializes the package. Untouched entries keep their exact bytes.
    pub fn save(&self) -> Result<Vec<u8>, Error> {
        if !self.is_modified() {
            return Ok(self.original.bytes.clone());
        }
        let src = &self.original.bytes;
        let mut out = Vec::with_capacity(src.len());
        let mut central = Vec::new();
        let mut count = 0usize;
        for entry in &self.original.entries {
            if self.removed.contains(&entry.name) {
                continue;
            }
            let offset = to_u32(out.len())?;
            match self.overrides.get(&entry.name) {
                None => {
                    out.extend_from_slice(&src[entry.local_start..entry.local_end]);
                    let mut record = entry.central.clone();
                    record[42..46].copy_from_slice(&offset.to_le_bytes());
                    central.extend_from_slice(&record);
                }
                Some(data) => {
                    let version_made_by = u16::from_le_bytes([entry.central[4], entry.central[5]]);
                    write_new_entry(&mut out, &mut central, &entry.name, data, entry.mod_time, entry.mod_date, version_made_by, entry.flags & 0x0800)?;
                }
            }
            count += 1;
        }
        for (name, data) in &self.overrides {
            if self.has_original(name) {
                continue;
            }
            // New parts use the DOS epoch so output stays deterministic.
            write_new_entry(&mut out, &mut central, name, data, 0, 0x21, 20, 0)?;
            count += 1;
        }
        let cd_offset = to_u32(out.len())?;
        out.extend_from_slice(&central);
        let count16 = u16::try_from(count).map_err(|_| Error::Unsupported("more than 65535 parts".into()))?;
        out.extend_from_slice(&EOCD_SIG.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&count16.to_le_bytes());
        out.extend_from_slice(&count16.to_le_bytes());
        out.extend_from_slice(&to_u32(central.len())?.to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&(self.original.comment.len() as u16).to_le_bytes());
        out.extend_from_slice(&self.original.comment);
        Ok(out)
    }

    /// A content key for a part: CRC-32 and size, read from the ZIP
    /// directory for untouched parts and computed for changed ones.
    pub fn content_key(&self, name: &str) -> Option<(u32, u64)> {
        if let Some(data) = self.overrides.get(name) {
            return Some((crc32fast::hash(data), data.len() as u64));
        }
        if self.removed.contains(name) {
            return None;
        }
        self.original.entries.iter().find(|e| e.name == name).map(|e| (e.crc, e.uncompressed_size as u64))
    }

    /// Compressed bytes of an untouched entry, for preservation checks.
    pub fn original_record(&self, name: &str) -> Option<&[u8]> {
        self.original
            .entries
            .iter()
            .find(|e| e.name == name)
            .map(|e| &self.original.bytes[e.local_start..e.local_end])
    }
}

fn to_u32(n: usize) -> Result<u32, Error> {
    u32::try_from(n).map_err(|_| Error::Unsupported("packages over 4 GiB".into()))
}

#[allow(clippy::too_many_arguments)]
fn write_new_entry(
    out: &mut Vec<u8>,
    central: &mut Vec<u8>,
    name: &str,
    data: &[u8],
    mod_time: u16,
    mod_date: u16,
    version_made_by: u16,
    utf8_flag: u16,
) -> Result<(), Error> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).map_err(|e| Error::Package(e.to_string()))?;
    let compressed = encoder.finish().map_err(|e| Error::Package(e.to_string()))?;
    let crc = crc32fast::hash(data);
    let offset = to_u32(out.len())?;
    let name_bytes = name.as_bytes();
    let name_len = name_bytes.len() as u16;
    let header = |sig: u32, buf: &mut Vec<u8>, is_central: bool| -> Result<(), Error> {
        buf.extend_from_slice(&sig.to_le_bytes());
        if is_central {
            buf.extend_from_slice(&version_made_by.to_le_bytes());
        }
        buf.extend_from_slice(&20u16.to_le_bytes());
        buf.extend_from_slice(&utf8_flag.to_le_bytes());
        buf.extend_from_slice(&8u16.to_le_bytes());
        buf.extend_from_slice(&mod_time.to_le_bytes());
        buf.extend_from_slice(&mod_date.to_le_bytes());
        buf.extend_from_slice(&crc.to_le_bytes());
        buf.extend_from_slice(&to_u32(compressed.len())?.to_le_bytes());
        buf.extend_from_slice(&to_u32(data.len())?.to_le_bytes());
        buf.extend_from_slice(&name_len.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        if is_central {
            buf.extend_from_slice(&[0; 6]); // comment len, disk start, internal attrs
            buf.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            buf.extend_from_slice(&offset.to_le_bytes());
        }
        buf.extend_from_slice(name_bytes);
        Ok(())
    };
    header(LOCAL_SIG, out, false)?;
    out.extend_from_slice(&compressed);
    header(CENTRAL_SIG, central, true)?;
    Ok(())
}

fn find_eocd(bytes: &[u8]) -> Result<usize, Error> {
    if bytes.len() < 22 {
        return Err(Error::Package("file too small to be a ZIP package".into()));
    }
    let lowest = bytes.len().saturating_sub(22 + 0xFFFF);
    (lowest..=bytes.len() - 22)
        .rev()
        .find(|&i| u32_at(bytes, i).ok() == Some(EOCD_SIG))
        .ok_or_else(|| Error::Package("end of central directory not found".into()))
}
