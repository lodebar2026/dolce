//! 标准 MIDI 文件（SMF）的读取（同 `midi/smf.ts`）：只取导入成谱要用的事件（音符、速度、拍号、调号、轨名），其余只记「有没有」。
//!
//! 读得宽：规范允许的外来块（非 `MTrk`）跳过；文件尾的填充字节、截断的末轨按读到的算——
//! 实际流传的 .mid 这两种都常见，按字节严格对账会把能用的文件当坏文件拒掉。
//! 只认按四分音符计 tick 的（PPQ）；SMPTE 计时的不认（返回 `None`）。

use serde::Serialize;

/// 一条事件。`tick` 是自轨首累计的 tick（TS `number`，这里 `f64`）。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SmfEvent {
    NoteOn { tick: f64, channel: u8, pitch: u8, velocity: u8 },
    NoteOff { tick: f64, channel: u8, pitch: u8, velocity: u8 },
    #[serde(rename_all = "camelCase")]
    Tempo { tick: f64, us_per_quarter: f64 },
    #[serde(rename_all = "camelCase")]
    TimeSig { tick: f64, beats: f64, beat_type: f64 },
    KeySig { tick: f64, fifths: f64, minor: bool },
    TrackName { tick: f64, text: String },
    /// 改变演奏而谱面上不转写的：踏板（CC 64/66/67）、调制轮（CC 1）踩下，弯音离开中位。音量、声像、音色这类设置不算
    Expression { tick: f64, channel: u8 },
}

impl SmfEvent {
    pub fn tick(&self) -> f64 {
        match self {
            SmfEvent::NoteOn { tick, .. }
            | SmfEvent::NoteOff { tick, .. }
            | SmfEvent::Tempo { tick, .. }
            | SmfEvent::TimeSig { tick, .. }
            | SmfEvent::KeySig { tick, .. }
            | SmfEvent::TrackName { tick, .. }
            | SmfEvent::Expression { tick, .. } => *tick,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Smf {
    pub format: u16,
    /// 每个四分音符的 tick 数
    pub ppq: u16,
    pub tracks: Vec<Vec<SmfEvent>>,
}

fn u32_at(b: &[u8], at: usize) -> u64 {
    ((b[at] as u64) << 24) + ((b[at + 1] as u64) << 16) + ((b[at + 2] as u64) << 8) + b[at + 3] as u64
}
fn u16_at(b: &[u8], at: usize) -> u16 {
    ((b[at] as u16) << 8) + b[at + 1] as u16
}

/// 读不出 SMF 头、或是 SMPTE 计时，返回 `None`。
pub fn parse_smf(bytes: &[u8]) -> Option<Smf> {
    if bytes.len() < 14 || &bytes[0..4] != b"MThd" {
        return None;
    }
    let head_len = u32_at(bytes, 4);
    if head_len < 6 {
        return None;
    }
    let format = u16_at(bytes, 8);
    let division = u16_at(bytes, 12);
    if division & 0x8000 != 0 || division == 0 {
        return None;
    }
    let len_all = bytes.len() as u64;
    let mut tracks = vec![];
    // 块长可到 4 GiB：偏移按 u64 算（wasm32 的 usize 会溢出）
    let mut at: u64 = 8 + head_len;
    while at + 8 <= len_all {
        let a = at as usize;
        let len = u32_at(bytes, a + 4);
        let end = len_all.min(at + 8 + len) as usize;
        if &bytes[a..a + 4] == b"MTrk" {
            tracks.push(parse_track(&bytes[a + 8..end]));
        }
        at += 8 + len;
    }
    Some(Smf { format, ppq: division, tracks })
}

/// 变长数：最多读 4 字节（到尾就停）
fn varlen(b: &[u8], at: &mut usize) -> usize {
    let mut v = 0usize;
    let mut k = 0;
    while k < 4 && *at < b.len() {
        let c = b[*at];
        *at += 1;
        v = v * 128 + (c & 0x7f) as usize;
        if c & 0x80 == 0 {
            return v;
        }
        k += 1;
    }
    v
}

fn parse_track(b: &[u8]) -> Vec<SmfEvent> {
    let mut out = vec![];
    let mut at = 0usize;
    let mut tick = 0.0f64;
    let mut running = 0u8;
    while at < b.len() {
        tick += varlen(b, &mut at) as f64;
        if at >= b.len() {
            break;
        }
        let mut status = b[at];
        if status & 0x80 != 0 {
            at += 1;
        } else if running != 0 {
            status = running; // 连续状态：沿用上一条通道消息的状态字节
        } else {
            break; // 没有状态可沿用：坏了，后面不读
        }
        if status == 0xff {
            let ty = b.get(at).copied();
            at += 1;
            let len = varlen(b, &mut at);
            let data = if at < b.len() { &b[at..b.len().min(at + len)] } else { &[][..] };
            at += len;
            match ty {
                Some(0x2f) => break,
                Some(0x51) if data.len() >= 3 => out.push(SmfEvent::Tempo {
                    tick,
                    us_per_quarter: (((data[0] as u32) << 16) + ((data[1] as u32) << 8) + data[2] as u32) as f64,
                }),
                Some(0x58) if data.len() >= 2 => out.push(SmfEvent::TimeSig { tick, beats: data[0] as f64, beat_type: 2f64.powi(data[1] as i32) }),
                Some(0x59) if data.len() >= 2 => out.push(SmfEvent::KeySig { tick, fifths: data[0] as i8 as f64, minor: data[1] == 1 }),
                Some(0x03) => out.push(SmfEvent::TrackName { tick, text: decode_text(data) }),
                _ => {}
            }
            continue;
        }
        if status == 0xf0 || status == 0xf7 {
            // 照搬 TS `at += varlen()`：左边的 `at` 先取值，varlen 读长度字节时的推进被盖掉，
            // 落点是「长度字节的起点 + 长度」（比规范少跳了长度字节本身）。迁移期旧 bug 照搬，切换后另修。
            let from = at;
            let len = varlen(b, &mut at);
            at = from + len;
            continue;
        }
        if status >= 0xf0 {
            break; // 文件里不该有的实时消息：当坏轨处理
        }
        running = status;
        let kind = status & 0xf0;
        let channel = status & 0x0f;
        let d1 = b.get(at).copied().unwrap_or(0);
        at += 1;
        let d2 = if kind == 0xc0 || kind == 0xd0 {
            0
        } else {
            let v = b.get(at).copied().unwrap_or(0);
            at += 1;
            v
        };
        if kind == 0x90 && d2 > 0 {
            out.push(SmfEvent::NoteOn { tick, channel, pitch: d1, velocity: d2 });
        } else if kind == 0x80 || kind == 0x90 {
            out.push(SmfEvent::NoteOff { tick, channel, pitch: d1, velocity: d2 });
        } else if (kind == 0xb0 && [1, 64, 66, 67].contains(&d1) && d2 > 0) || (kind == 0xe0 && ((d2 as u32) << 7) + d1 as u32 != 0x2000) {
            out.push(SmfEvent::Expression { tick, channel });
        }
    }
    out
}

/// 轨名：先按 UTF-8（同 `TextDecoder` 缺省去掉开头 BOM），不合法再按 GBK（国内软件导出的中文轨名多是 GBK）。
fn decode_text(data: &[u8]) -> String {
    let s = match std::str::from_utf8(data) {
        Ok(s) => s.strip_prefix('\u{feff}').unwrap_or(s).to_string(),
        Err(_) => encoding_rs::GBK.decode_without_bom_handling(data).0.into_owned(),
    };
    dolce_base::js::trim(&s).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn smf(tracks: &[&[u8]]) -> Vec<u8> {
        let mut b = b"MThd\0\0\0\x06\0\x01".to_vec();
        b.extend_from_slice(&(tracks.len() as u16).to_be_bytes());
        b.extend_from_slice(&480u16.to_be_bytes());
        for t in tracks {
            b.extend_from_slice(b"MTrk");
            b.extend_from_slice(&(t.len() as u32).to_be_bytes());
            b.extend_from_slice(t);
        }
        b
    }

    #[test]
    fn running_status_and_meta() {
        let t: &[u8] = &[0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0x90, 60, 100, 0x83, 0x60, 60, 0, 0, 0xff, 0x2f, 0];
        let s = parse_smf(&smf(&[t])).unwrap();
        assert_eq!(s.ppq, 480);
        assert_eq!(s.tracks[0].len(), 3);
        assert_eq!(s.tracks[0][0], SmfEvent::Tempo { tick: 0.0, us_per_quarter: 500000.0 });
        assert_eq!(s.tracks[0][2], SmfEvent::NoteOff { tick: 480.0, channel: 0, pitch: 60, velocity: 0 });
    }

    #[test]
    fn rejects_smpte_and_short() {
        assert!(parse_smf(b"MThd").is_none());
        let mut b = smf(&[]);
        b[12] = 0xe7;
        assert!(parse_smf(&b).is_none());
    }

    #[test]
    fn gbk_track_name() {
        // 「中文」的 GBK
        let t: &[u8] = &[0, 0xff, 0x03, 4, 0xd6, 0xd0, 0xce, 0xc4];
        let s = parse_smf(&smf(&[t])).unwrap();
        assert_eq!(s.tracks[0][0], SmfEvent::TrackName { tick: 0.0, text: "中文".into() });
    }

    #[test]
    fn truncated_track_reads_what_is_there() {
        let mut b = smf(&[&[0, 0x90, 60, 100, 0x60, 0x80, 60]]);
        // 声称的块长比实际长
        b[21] = 0x40;
        let s = parse_smf(&b).unwrap();
        assert_eq!(s.tracks[0].len(), 2);
    }
}
