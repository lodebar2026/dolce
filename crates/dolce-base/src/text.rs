//! 原文位置：Rust 里按 UTF-8 字节切串，交给 TS（CodeMirror、`SourceSpan`、XML 原文区间）的一律是 **UTF-16 码元**。

use serde::{Deserialize, Serialize};

/// 源码区间（同 `model/doc.ts::SourceSpan`）：0 基行号、行内 0 基列、全文 0 基偏移与长度，都按 UTF-16 码元。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceSpan {
    pub line: u32,
    pub column: u32,
    pub offset: u32,
    pub length: u32,
}

/// 一个非 ASCII 字符：起点的字节偏移、UTF-16 偏移，与它占的字节数、码元数。
#[derive(Clone, Copy, Debug)]
struct Wide {
    byte: u32,
    u16: u32,
    bytes: u8,
    units: u8,
}

/// 字节偏移 ↔ UTF-16 偏移的换算表。只记非 ASCII 字符，纯 ASCII 原文表是空的、换算即恒等。
#[derive(Clone, Debug, Default)]
pub struct Utf16Index {
    wide: Vec<Wide>,
    len_bytes: u32,
    len_u16: u32,
}

impl Utf16Index {
    pub fn new(s: &str) -> Utf16Index {
        let mut wide = Vec::new();
        let mut u = 0u32;
        for (b, c) in s.char_indices() {
            let units = c.len_utf16() as u32;
            if !c.is_ascii() {
                wide.push(Wide { byte: b as u32, u16: u, bytes: c.len_utf8() as u8, units: units as u8 });
            }
            u += units;
        }
        Utf16Index { wide, len_bytes: s.len() as u32, len_u16: u }
    }

    /// 全文的 UTF-16 长度（JS 的 `s.length`）。
    pub fn len_u16(&self) -> u32 {
        self.len_u16
    }

    /// 字节偏移 → UTF-16 偏移（落在字符中间的按该字符起点算）。
    pub fn to_u16(&self, byte: usize) -> u32 {
        let byte = byte as u32;
        let k = self.wide.partition_point(|w| w.byte < byte);
        if k == 0 {
            return byte;
        }
        let w = self.wide[k - 1];
        let end = w.byte + w.bytes as u32;
        if byte < end {
            w.u16
        } else {
            w.u16 + w.units as u32 + (byte - end)
        }
    }

    /// UTF-16 偏移 → 字节偏移（落在代理对中间的按该字符起点算；越界截到末尾）。
    pub fn to_byte(&self, u16: u32) -> usize {
        let u16 = u16.min(self.len_u16);
        let k = self.wide.partition_point(|w| w.u16 < u16);
        if k == 0 {
            return u16 as usize;
        }
        let w = self.wide[k - 1];
        let end = w.u16 + w.units as u32;
        if u16 < end {
            w.byte as usize
        } else {
            (w.byte + w.bytes as u32 + (u16 - end)).min(self.len_bytes) as usize
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let s = "a中𝄞b\r\nc";
        let ix = Utf16Index::new(s);
        assert_eq!(ix.len_u16(), s.encode_utf16().count() as u32);
        for (b, _) in s.char_indices().chain([(s.len(), ' ')]) {
            let u = ix.to_u16(b);
            assert_eq!(u as usize, s[..b].encode_utf16().count());
            assert_eq!(ix.to_byte(u), b);
        }
        assert_eq!(ix.to_byte(3), 4); // 𝄞 的低代理 → 𝄞 起点
        assert_eq!(Utf16Index::new("abc").to_u16(2), 2);
    }
}
