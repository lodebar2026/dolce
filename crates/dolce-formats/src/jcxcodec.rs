//! Muse `.jcx` 的字节 ↔ 文本（TS `common/jcxcodec.ts` 照搬；说明书「Muse 保存的文件格式」）：
//!
//! - `%MUSE2` 开头：3.1 以前的版本存的，简体中文版 GBK、繁体中文版 BIG5；
//! - `%MUSE3` 开头：3.1 起存的，固定 UTF-8。3.1 以前的 Muse 打不开（乱码）。
//!
//! 写出**默认 `%MUSE2` + GBK**：新旧版 Muse 都能开（用 Muse 的多是长者，手里常是旧版）。
//! 打开的就是 `%MUSE3` 文件时照原样 UTF-8 存回，不降级。Muse 是 Windows 软件，行尾写 CRLF。
//!
//! 解码用 encoding_rs（与浏览器 `TextDecoder` 同一套 WHATWG 编码表）。GBK 写出照 TS 的做法建反查表：
//! 逐个双字节码（首字节 0x81–0xFE、尾字节 0x40–0xFE 除 0x7F）解一遍，解成单个字的记下、先到先得——
//! 不用 encoding_rs 的 GBK 编码器：它把 € 写成单字节 0x80、能写出 18 个解码时并不还原的私用区字，与 TS 写出的字节不同。

use std::collections::HashMap;
use std::sync::OnceLock;

use dolce_base::js;
use encoding_rs::{Encoding, BIG5, GBK, UTF_16BE, UTF_16LE, UTF_8};

fn gbk_table() -> &'static HashMap<char, u16> {
    static TABLE: OnceLock<HashMap<char, u16>> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut map = HashMap::new();
        for hi in 0x81u16..=0xfe {
            for lo in 0x40u16..=0xfe {
                if lo == 0x7f {
                    continue;
                }
                let pair = [hi as u8, lo as u8];
                let (s, _) = GBK.decode_without_bom_handling(&pair);
                let mut cs = s.chars();
                if let (Some(ch), None) = (cs.next(), cs.next()) {
                    // TS 判 `ch.length === 1`（UTF-16 码元）：非 BMP 的字解出来是两个码元，不收
                    if ch != '\u{fffd}' && (ch as u32) < 0x10000 {
                        map.entry(ch).or_insert((hi << 8) | lo);
                    }
                }
            }
        }
        map
    })
}

fn bad(s: &str) -> usize {
    s.chars().filter(|&c| c == '\u{fffd}').count()
}

/// 双字节字里尾字节落在 0x40–0x7E 的比例超过这个数就按 BIG5 读。谱例 45 首（简体 GBK）最高 0.75%；
/// BIG5 的繁体文本一般在四成上下（这一段常用字最多）。
const BIG5_LOW_TRAIL: f64 = 0.15;

fn looks_big5(bytes: &[u8]) -> bool {
    let mut pairs = 0u32;
    let mut low = 0u32;
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] < 0x81 {
            i += 1;
            continue;
        }
        pairs += 1;
        let t = bytes[i + 1];
        if (0x40..=0x7e).contains(&t) {
            low += 1;
        }
        i += 2;
    }
    pairs > 0 && low as f64 / pairs as f64 > BIG5_LOW_TRAIL
}

/// `TextDecoder(enc).decode(bytes)`：替换坏字节，去掉本编码自己的 BOM。
fn decode_with(enc: &'static Encoding, bytes: &[u8]) -> String {
    enc.decode_with_bom_removal(bytes).0.into_owned()
}

/// 行尾归一成 `\n`（TS `common/lines.ts::normalizeEol`：`/\r\n?/g`）。
fn normalize_eol(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// 字节 → 文本（行尾归一成 `\n`）。BOM 优先；`%MUSE3` 或合法 UTF-8 按 UTF-8；否则 GBK；字节分布像 BIG5 的（繁体版 Muse）按 BIG5。
pub fn decode_jcx(bytes: &[u8]) -> String {
    let text = if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        decode_with(UTF_8, &bytes[3..])
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        decode_with(UTF_16LE, &bytes[2..])
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        decode_with(UTF_16BE, &bytes[2..])
    } else {
        match std::str::from_utf8(bytes) {
            // 纯 ASCII 与 `%MUSE3` 都在这一档；GBK 的中文几乎不可能恰好是合法 UTF-8
            Ok(s) => s.to_string(),
            Err(_) => {
                let gbk = GBK.decode_without_bom_handling(bytes).0.into_owned();
                // GBK 解码器能把 BIG5 的每对字节都解成**某个字**，不出替换字符，所以不能等它报错再改试 BIG5：
                // 按字节判——BIG5 的常用字大量用 0x40–0x7E 当尾字节，简体 GBK 文本几乎全落在 GB2312 区（尾字节 ≥ 0xA1）
                if looks_big5(bytes) {
                    let big5 = BIG5.decode_without_bom_handling(bytes).0.into_owned();
                    if bad(&big5) <= bad(&gbk) {
                        big5
                    } else {
                        gbk
                    }
                } else {
                    gbk
                }
            }
        }
    };
    normalize_eol(&text)
}

/// 文本 → 字节，外加 GBK 里没有、写成了 `?` 的字（按出现先后、不重复，调用方报给用户）。
pub fn encode_jcx(text: &str) -> (Vec<u8>, Vec<char>) {
    // `/\r?\n/g` → `\r\n`
    let crlf = text.replace("\r\n", "\n").replace('\n', "\r\n");
    // `/^\s*%MUSE3/`
    if text.trim_start_matches(js::is_space).starts_with("%MUSE3") {
        return (crlf.into_bytes(), vec![]);
    }
    let map = gbk_table();
    let mut out = Vec::with_capacity(crlf.len());
    let mut missing: Vec<char> = vec![];
    for ch in crlf.chars() {
        let c = ch as u32;
        if c < 0x80 {
            out.push(c as u8);
            continue;
        }
        match map.get(&ch) {
            Some(&code) => out.extend([(code >> 8) as u8, (code & 0xff) as u8]),
            None => {
                if !missing.contains(&ch) {
                    missing.push(ch);
                }
                out.push(b'?');
            }
        }
    }
    (out, missing)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gbk_round_trip() {
        let (b, missing) = encode_jcx("%MUSE2\n中文€\u{1D11E}");
        assert_eq!(missing, vec!['\u{1D11E}']);
        assert_eq!(&b[..8], b"%MUSE2\r\n");
        assert_eq!(&b[12..14], &[0xa2, 0xe3]); // € 照 TS 写双字节 A2E3
        assert_eq!(decode_jcx(&b), "%MUSE2\n中文€?");
        assert_eq!(gbk_table().len(), 23939);
    }

    #[test]
    fn muse3_utf8() {
        let (b, m) = encode_jcx("  %MUSE3\r\n中");
        assert!(m.is_empty());
        assert_eq!(b, "  %MUSE3\r\n中".as_bytes());
        assert_eq!(decode_jcx(&b), "  %MUSE3\n中");
    }
}
