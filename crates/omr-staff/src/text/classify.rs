//! 文字行的分类与归属（M4 4.2~4.5）：歌词行归上面那行谱、逐行编号；和弦、节拍器归下面那行谱；
//! 力度、跳转、表情术语归近的那行。只定「是什么、在哪一行谱的哪个 x」，挂到哪个音由整曲拼接时按 x 定。
use super::lines::{Band, GeoLine, Seg};
use crate::page::PageFrame;
use dolce_omr_sheet::score::Dir;
use dolce_omr_text::chars::{han_count, latin_count, script_of, Script};
use dolce_omr_text::lyrics::{syllables, LyricRow};
use dolce_omr_text::{chords, words, Ch};

/// 第一行歌词离谱表不过这么多格；之后各行与上一行的空隙不过较矮那行行高的这个比例。
const LYRIC_FIRST: f64 = 9.0;
const LYRIC_GAP: f64 = 0.8;
/// 和弦记号离下面那行谱的首线不过这么多格。
const CHORD_REACH: f64 = 5.5;
/// 力度、术语、跳转离所归的谱行不过这么多格。
const MARK_REACH: f64 = 7.0;

/// 一行歌词：第几行（1 起，自上而下）与各音节（x 是页内坐标）。
#[derive(Clone, Debug)]
pub struct LyricLine {
    /// 同一行谱下、同一种文字里的第几行（1 起）。汉字词与拉丁词各编各的：主歌五行汉字在两行谱之间、
    /// 副歌一行汉字一行英文上下挨着，按 y 一路数下去副歌的英文就成了第 2 行、接不上主歌的英文。
    /// 写出时拉丁词的行号排在全曲汉字词之后（[`crate::song`]）。
    pub number: u8,
    pub latin: bool,
    pub row: LyricRow,
    /// 行的纵向范围（页内坐标）。
    pub y0: f64,
    pub y1: f64,
}

/// 一个要挂到拍点上的记号 / 文字。
#[derive(Clone, Debug)]
pub struct Mark {
    pub x: f64,
    pub dir: Dir,
}

/// 一行谱的文字。
#[derive(Clone, Debug, Default)]
pub struct RowText {
    pub lyrics: Vec<LyricLine>,
    pub marks: Vec<Mark>,
}

fn line_chars(l: &GeoLine) -> Vec<Ch> {
    let mut out: Vec<Ch> = Vec::new();
    for s in &l.segs {
        if let (Some(p), Some(n)) = (out.last(), s.chars.first()) {
            let sep = Ch { ch: ' ', x0: p.x1, x1: n.x0 };
            out.push(sep);
        }
        out.extend(s.chars.iter().cloned());
    }
    out
}

/// 像歌词的一行：两个以上汉字，或以拉丁字母为主的一串词。
fn lyric_like(text: &str) -> bool {
    let total = text.chars().filter(|c| !c.is_whitespace()).count();
    let (h, l) = (han_count(text), latin_count(text));
    h >= 2 || (l >= 4 && l * 10 >= total * 6)
}

/// 一段字是不是记号 / 文字指示；是的话交出来。`above`：印在所归谱行的上方。
fn mark_of(seg: &Seg, above: bool, chord_ok: bool) -> Vec<Mark> {
    let t = seg.text();
    let t = t.trim();
    let x = seg.rect.x;
    if let Some(d) = words::dynamic(t) {
        return vec![Mark { x: seg.rect.cx(), dir: Dir::Dynamics(d.to_string()) }];
    }
    if let Some((n, circa)) = words::metronome(t) {
        return vec![Mark { x, dir: Dir::Metronome { per_minute: n, circa } }];
    }
    if let Some(j) = words::jump(t) {
        return vec![Mark { x, dir: Dir::Words { text: t.to_string(), above, jump: Some(j) } }];
    }
    if chord_ok && chords::is_annotation_line(t) {
        // 切词在逐字序列上做（下标对得上字位）
        let s: String = seg.chars.iter().map(|c| c.ch).collect();
        let xs: Vec<f64> = seg.chars.iter().map(|c| c.cx()).collect();
        let x_at = |i: usize| xs.get(i).copied().unwrap_or(0.0);
        return chords::split_tokens(&chords::blank_non_chord(&s), Some(&x_at))
            .into_iter()
            .map(|tk| Mark { x: seg.chars[tk.index].x0, dir: Dir::Harmony(chords::normalize(&tk.tok)) })
            .collect();
    }
    if words::has_term(t) && latin_count(t) >= 3 && t.chars().count() <= 32 && han_count(t) == 0 {
        return vec![Mark { x, dir: Dir::Words { text: t.to_string(), above, jump: None } }];
    }
    Vec::new()
}

/// 各条带的行 → 各行谱的歌词与记号（与 `staves` 同序）。
pub fn classify(f: &PageFrame, bands: &[Band]) -> Vec<RowText> {
    let mut rows: Vec<RowText> = (0..f.staves.len()).map(|_| RowText::default()).collect();
    for b in bands {
        // 歌词链：从上面那行谱往下数
        let mut chain_end: Option<(f64, f64)> = None; // (上一行歌词的底, 行高)
        let mut number = [0u8; 2];
        let mut broken = b.above.is_none();
        for l in &b.lines {
            let cx = l.cx();
            let d_above = b.above.map(|a| {
                let s = &f.staves[a];
                (l.y0 - s.bottom(cx.clamp(s.left, s.right))) / s.space()
            });
            let d_below = b.below.map(|z| {
                let s = &f.staves[z];
                (s.top(cx.clamp(s.left, s.right)) - l.y1) / s.space()
            });
            let chars = line_chars(l);
            let text: String = chars.iter().map(|c| c.ch).collect();
            // 和弦行优先：贴着下面那行谱、整行是和弦记号
            let chord_line = d_below.is_some_and(|d| d <= CHORD_REACH) && chords::is_annotation_line(&text);
            let in_chain = !broken
                && !chord_line
                && lyric_like(&text)
                && match chain_end {
                    None => d_above.is_some_and(|d| d <= LYRIC_FIRST),
                    Some((bottom, h)) => l.y0 - bottom <= LYRIC_GAP * h.min(l.h()),
                };
            if in_chain {
                let a = b.above.unwrap();
                // 行里夹着的跳转记号（行尾的 Fine、D.C.）单独挂
                let mut lyric_chars: Vec<Ch> = Vec::new();
                for s in &l.segs {
                    if let Some(j) = words::jump(s.text().trim()) {
                        rows[a].marks.push(Mark { x: s.rect.x, dir: Dir::Words { text: s.text().trim().to_string(), above: false, jump: Some(j) } });
                        continue;
                    }
                    if let (Some(p), Some(n)) = (lyric_chars.last(), s.chars.first()) {
                        let sep = Ch { ch: ' ', x0: p.x1, x1: n.x0 };
                        lyric_chars.push(sep);
                    }
                    lyric_chars.extend(s.chars.iter().cloned());
                }
                let row = syllables(&lyric_chars);
                if !row.syls.is_empty() {
                    let latin = script_of(&row.syls.iter().map(|s| s.text.as_str()).collect::<String>()) == Script::Latin;
                    number[latin as usize] += 1;
                    rows[a].lyrics.push(LyricLine { number: number[latin as usize], latin, row, y0: l.y0, y1: l.y1 });
                    chain_end = Some((l.y1, l.h()));
                    continue;
                }
            }
            if chain_end.is_some() && lyric_like(&text) {
                // 链断了：后面的成行文字是脚注、版权，不再当歌词
                broken = true;
            }
            // 记号与文字指示：逐段看，归近的那行谱
            let to_below = match (d_above, d_below) {
                (Some(a), Some(z)) => z < a,
                (None, _) => true,
                _ => false,
            };
            let (si, dist) = if to_below { (b.below, d_below) } else { (b.above, d_above) };
            let (Some(si), Some(dist)) = (si, dist) else { continue };
            if dist > MARK_REACH {
                continue;
            }
            for s in &l.segs {
                // 和弦只归下面那行谱
                let chord_ok = d_below.is_some_and(|d| d <= CHORD_REACH);
                for m in mark_of(s, to_below, chord_ok) {
                    let row = if matches!(m.dir, Dir::Harmony(_) | Dir::Metronome { .. }) { b.below.unwrap_or(si) } else { si };
                    rows[row].marks.push(m);
                }
            }
        }
    }
    fold_bilingual(f, &mut rows);
    rows
}

/// 中英对照的闭合谱：汉字词印在两行谱之间、英文词印在下面那行谱之下，唱的是同一条旋律——
/// 同系统里上一行谱有汉字词、下一行谱的词全是拉丁字母的，拉丁那几行接到上一行谱的词后面。
fn fold_bilingual(f: &PageFrame, rows: &mut [RowText]) {
    for sys in &f.systems {
        for w in sys.staves.windows(2) {
            let (u, l) = (w[0], w[1]);
            if rows[u].lyrics.iter().any(|x| !x.latin) && !rows[l].lyrics.is_empty() && rows[l].lyrics.iter().all(|x| x.latin) {
                let base = rows[u].lyrics.iter().filter(|x| x.latin).count() as u8;
                let moved: Vec<LyricLine> = std::mem::take(&mut rows[l].lyrics).into_iter().map(|mut x| { x.number += base; x }).collect();
                rows[u].lyrics.extend(moved);
            }
        }
    }
}
