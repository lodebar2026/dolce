//! 标准 MIDI 文件（format 1）写出（TS `score/midi.ts` 照搬，原出 mp/score/midi.kt）：指挥轨（速度、拍号、调号）、
//! 每声部一轨（note on/off，力度来自力度记号）。音符时刻取 [`crate::timeline::build_timeline`]（与试听同一份），
//! 所以导出的 MIDI 照展开的演唱顺序（反复 / 房号 / D.C. / D.S.）。
//!
//! 字节口径照 TS：事件数据先按 JS number 记，最后 `new Uint8Array(…)` 时逐个 ToUint8（取模 256）。

use dolce_base::js;

use crate::timeline::{build_timeline, part_gain, play_tempo, Click, PlayOptions, PlaySource, Signature, TimedNote};

const PPQ: f64 = 960.0;

#[derive(Clone)]
struct Ev {
    tick: f64,
    data: Vec<f64>,
    /// 同一 tick 的先后：note-off (0) → 歌词 (1) → note-on (2)
    order: f64,
}

/// JS 的 ToInt32（`x | 0`、`x & m`、`x >> n` 先做的那一步）
fn int(x: f64) -> i32 {
    js::to_int32(x)
}

fn var_len(n: f64) -> Vec<f64> {
    let mut n = int(n);
    let mut bytes = vec![(n & 0x7f) as f64];
    n >>= 7;
    while n > 0 {
        bytes.insert(0, ((n & 0x7f) | 0x80) as f64);
        n >>= 7;
    }
    bytes
}

fn track_chunk(mut events: Vec<Ev>) -> Vec<f64> {
    js::sort_by(&mut events, |a, b| {
        let d = a.tick - b.tick;
        if d != 0.0 && !d.is_nan() {
            d
        } else {
            a.order - b.order
        }
    });
    let mut body: Vec<f64> = vec![];
    let mut prev = 0.0;
    for e in &events {
        body.extend(var_len(e.tick - prev));
        body.extend_from_slice(&e.data);
        prev = e.tick;
    }
    body.extend(var_len(0.0));
    body.extend([0xff as f64, 0x2f as f64, 0.0]); // end of track
    let len = body.len() as i32;
    let mut out: Vec<f64> = vec![0x4d as f64, 0x54 as f64, 0x72 as f64, 0x6b as f64];
    out.extend([(len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff].map(|b| b as f64));
    out.extend(body);
    out
}

/// 文字类元事件（`FF type len text`），文本按 UTF-8 写（中文歌词各家歌声合成软件都这么认）。
fn meta_text(kind: f64, text: &str) -> Vec<f64> {
    let bytes = text.as_bytes();
    let mut out = vec![0xff as f64, kind];
    out.extend(var_len(bytes.len() as f64));
    out.extend(bytes.iter().map(|&b| b as f64));
    out
}

/// 指挥轨：速度，外加拍号（`FF 58`，分母不是 2 的幂的不写）与调号（`FF 59`）的变化点。
fn tempo_track(bpm: f64, signatures: &[Signature]) -> Vec<f64> {
    let mpqn = int(js::round(60000000.0 / bpm));
    let mut events = vec![Ev {
        tick: 0.0,
        order: 0.0,
        data: [0xff, 0x51, 0x03, (mpqn >> 16) & 0xff, (mpqn >> 8) & 0xff, mpqn & 0xff].map(|b| b as f64).to_vec(),
    }];
    for s in signatures {
        let tick = js::round(s.t * PPQ);
        let denominator = s.time.beat_type.log2();
        if denominator.is_finite() && denominator.fract() == 0.0 && s.time.beats > 0.0 && s.time.beats <= 255.0 {
            events.push(Ev { tick, order: 1.0, data: vec![0xff as f64, 0x58 as f64, 4.0, s.time.beats, denominator, 24.0, 8.0] });
        }
        if let Some(k) = s.key {
            if k.fifths >= -7.0 && k.fifths <= 7.0 {
                events.push(Ev { tick, order: 2.0, data: vec![0xff as f64, 0x59 as f64, 2.0, (int(k.fifths) & 0xff) as f64, if k.minor { 1.0 } else { 0.0 }] });
            }
        }
    }
    track_chunk(events)
}

/// GM 的打击乐通道（第 10 通道）：声部不占它，节拍器的嘀嗒写在这儿。
const DRUM_CHANNEL: i32 = 9;
/// 节拍器的音：小节第一拍高木鱼、其余低木鱼（GM 1 就有，各家音源都认）。
const CLICK_DOWN: f64 = 76.0;
const CLICK_BEAT: f64 = 77.0;

/// `lyrics` = 把每个音这一遍唱的字写成歌词事件：note-on 同一 tick、紧挨在它前面，
/// Lyric（`FF 05`）与 Text（`FF 01`）各一条（只认其中一种的软件都读得到，issue 16 的 X Studio 样例即如此）。
fn part_track(notes: &[TimedNote], part_idx: usize, opts: Option<&PlayOptions>, name: Option<&str>, lyrics: bool) -> Vec<f64> {
    // 第 10 个声部起让过打击乐通道
    let pi = part_idx as i32;
    let channel = (if pi < DRUM_CHANNEL { pi } else { pi + 1 }) & 0x0f;
    let mut events: Vec<Ev> = vec![];
    if let Some(name) = name.filter(|n| !n.is_empty()) {
        events.push(Ev { tick: 0.0, order: -1.0, data: meta_text(0x03 as f64, name) });
    }
    // Channel Volume (CC7) at tick 0 sets this part's level in the GM synth.
    let vol = int(js::round(part_gain(opts, part_idx) * 127.0));
    events.push(Ev { tick: 0.0, order: 0.0, data: vec![(0xb0 | channel) as f64, 0x07 as f64, (vol & 0x7f) as f64] });
    for n in notes {
        if n.part != part_idx {
            continue;
        }
        let start = js::round(n.t0 * PPQ);
        let end = js::round(n.t1 * PPQ);
        if lyrics {
            if let Some(l) = &n.lyric {
                events.push(Ev { tick: start, order: 1.0, data: meta_text(0x05 as f64, l) });
                events.push(Ev { tick: start, order: 1.0, data: meta_text(0x01 as f64, l) });
            }
        }
        events.push(Ev { tick: start, order: 2.0, data: vec![(0x90 | channel) as f64, (int(n.pitch) & 0x7f) as f64, (int(n.velocity) & 0x7f) as f64] });
        events.push(Ev { tick: end, order: 0.0, data: vec![(0x80 | channel) as f64, (int(n.pitch) & 0x7f) as f64, 0.0] });
    }
    track_chunk(events)
}

/// 节拍器轨：每拍一个打击乐音，小节第一拍高一些、响一些。
fn click_track(clicks: &[Click]) -> Vec<f64> {
    let mut events: Vec<Ev> = vec![];
    for c in clicks {
        let start = js::round(c.t * PPQ);
        let pitch = if c.down { CLICK_DOWN } else { CLICK_BEAT };
        events.push(Ev { tick: start, order: 2.0, data: vec![(0x90 | DRUM_CHANNEL) as f64, pitch, if c.down { 120.0 } else { 90.0 }] });
        events.push(Ev { tick: start + PPQ / 8.0, order: 0.0, data: vec![(0x80 | DRUM_CHANNEL) as f64, pitch, 0.0] });
    }
    track_chunk(events)
}

/// JS 的 ToUint8（`new Uint8Array([x])`）
fn to_u8(x: f64) -> u8 {
    (js::to_int32(x) & 0xff) as u8
}

/// `click` = 把节拍器的嘀嗒写成一条打击乐轨（`opts.metronome` 开着才有）。只有原生音源试听传它：
/// 嘀嗒与音符由同一个定序器播，不会错拍。导出 MIDI 不传，文件里不带节拍器。
/// 导出的 MIDI 各声部轨带轨名与歌词事件（按演唱顺序逐遍取段）；试听那份不带歌词。
pub fn to_midi(src: &PlaySource, opts: Option<&PlayOptions>, click: bool) -> Vec<u8> {
    let tl = build_timeline(src);
    let with_click = click && opts.and_then(|o| o.metronome) == Some(true) && !tl.clicks.is_empty();
    let ntracks = (1 + src.parts.len() + usize::from(with_click)) as i32;
    let ppq = PPQ as i32;
    let mut out: Vec<f64> = [
        0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, // MThd, len 6
        0, 1, // format 1
        (ntracks >> 8) & 0xff, ntracks & 0xff,
        (ppq >> 8) & 0xff, ppq & 0xff, // division (ticks per quarter)
    ]
    .map(|b| b as f64)
    .to_vec();
    out.extend(tempo_track(play_tempo(src.play_data.tempo, opts), &tl.signatures));
    for (i, p) in src.parts.iter().enumerate() {
        out.extend(part_track(&tl.notes, i, opts, p.name.as_deref(), !click));
    }
    if with_click {
        out.extend(click_track(&tl.clicks));
    }
    out.into_iter().map(to_u8).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn var_len_bytes() {
        assert_eq!(var_len(0.0), vec![0.0]);
        assert_eq!(var_len(127.0), vec![127.0]);
        assert_eq!(var_len(128.0), vec![129.0, 0.0]);
        assert_eq!(var_len(960.0), vec![0x87 as f64, 0x40 as f64]);
    }
}
