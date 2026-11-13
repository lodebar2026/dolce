//! JM2 / JM4 文字：谱行之间的歌词行（切行、分段取条送 rec、对到音上）、页眉（标题、署名、曲号、调号、拍号、速度）。
//!
//! 行按像素的纵向投影切（顺着行带的斜率投影），已归了音符的墨（减时线、低音点）不算字。
//! 字的分类、切音节、对音、页眉分类用 `omr-text`（与五线谱路线同一份）。
use crate::frame::{digit_cell, RowFrame};
use crate::notes::RowNotes;
use crate::prep::Ink;
use crate::result::{RecognizedScore, TextRegion, TimeSig};
use dolce_omr_core::geom::median;
use dolce_omr_core::image::Rect;
use dolce_omr_ocr::cache::CachedOcr;
use dolce_omr_text::chars::{han_count, is_han};
use dolce_omr_text::header::{credits, CreditType, WordLine};
use dolce_omr_text::lyrics::{align, syllables};
use dolce_omr_text::spaces::recover_spaces;
use dolce_omr_text::{chords, words, Ch};
use regex::Regex;
use std::sync::LazyLock;

/// 页面大小的占用图：已归了音符的墨。
pub struct Claims {
    w: usize,
    mask: Vec<u8>,
}

impl Claims {
    pub fn new(ink: &Ink, rects: impl Iterator<Item = Rect>) -> Claims {
        let (w, h) = (ink.w(), ink.h());
        let mut mask = vec![0u8; w * h];
        for r in rects {
            for y in (r.y.max(0.0) as usize)..(r.bottom().ceil() as usize).min(h) {
                for x in (r.x.max(0.0) as usize)..(r.right().ceil() as usize).min(w) {
                    mask[y * w + x] = 1;
                }
            }
        }
        Claims { w, mask }
    }
    /// 竖着连续不短于 `min_len` 的墨（连谱号、系统线、贯穿几行的小节线）也记成占用：字的竖笔不过一行字高，
    /// 这种竖线在投影里每行都留几个像素，把上下几行歌词连成一截、切不开。
    pub fn tall_runs(mut self, ink: &Ink, min_len: f64) -> Claims {
        let (w, h) = (ink.w(), ink.h());
        let min_len = min_len.max(2.0) as usize;
        for x in 0..w {
            let mut y = 0;
            while y < h {
                if !ink.at(x as i64, y as i64) {
                    y += 1;
                    continue;
                }
                let a = y;
                while y < h && ink.at(x as i64, y as i64) {
                    y += 1;
                }
                if y - a >= min_len {
                    for yy in a..y {
                        self.mask[yy * w + x] = 1;
                    }
                }
            }
        }
        self
    }
    fn free(&self, ink: &Ink, x: i64, y: i64) -> bool {
        ink.at(x, y) && self.mask[y as usize * self.w + x as usize] == 0
    }
}

/// 一条带 `[ya, yb)` 里的字行（纵向范围）。`slope`：行带斜率，投影时折掉。
/// 一截墨行不矮于 `min_h`、墨够密才算字行；几行挤成一截的在投影的谷里切开。
/// `one`：本页一行字的高（没给就不切挤在一起的行，回的是原始的各截——第一遍估行高用）。
fn cut_lines(ink: &Ink, claims: &Claims, slope: f64, ya: i64, yb: i64, xr: (i64, i64), min_h: f64, one: Option<f64>) -> Vec<(i64, i64)> {
    cut_lines_at(ink, claims, slope, ya, yb, xr, min_h, one, LINE_INK)
}

/// 一行字的墨至少占「行高 × 页宽」的这么多（弧、点凑的一截到不了）。
const LINE_INK: f64 = 0.006;
/// 谱后诗行里独占一行的段号（一个「二」）只有这么点墨。
const LABEL_INK: f64 = 0.0006;

/// 同 [`cut_lines`]，墨的密度门由 `min_ink` 给。
#[allow(clippy::too_many_arguments)]
fn cut_lines_at(ink: &Ink, claims: &Claims, slope: f64, ya: i64, yb: i64, xr: (i64, i64), min_h: f64, one: Option<f64>, min_ink: f64) -> Vec<(i64, i64)> {
    let w = ink.w() as i64;
    let (xa, xb) = (xr.0.max(0), xr.1.min(w));
    if yb <= ya {
        return Vec::new();
    }
    let n = (yb - ya) as usize;
    let mut proj = vec![0u32; n];
    for y in ya.max(0)..yb.min(ink.h() as i64) {
        for x in xa..xb {
            if claims.free(ink, x, y) {
                let yy = y - (slope * (x - w / 2) as f64).round() as i64 - ya;
                if yy >= 0 && (yy as usize) < n {
                    proj[yy as usize] += 1;
                }
            }
        }
    }
    let mut runs: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < n {
        if proj[i] < 2 {
            i += 1;
            continue;
        }
        let a = i;
        while i < n && proj[i] >= 2 {
            i += 1;
        }
        runs.push((a, i - 1));
    }
    // 上下分开的几笔（「二」「三」两三道横）：空当不过六成行字高、合起来不过一行字高的并成一截
    if let Some(one) = one {
        let mut merged: Vec<(usize, usize)> = Vec::new();
        for r in runs {
            match merged.last_mut() {
                Some(m) if ((r.0 - m.1 - 1) as f64) <= one * 0.6 && ((r.1 - m.0 + 1) as f64) <= one * 1.1 && ((m.1 - m.0 + 1) as f64) < one * 0.5 => m.1 = r.1,
                _ => merged.push(r),
            }
        }
        runs = merged;
    }
    let dense = |a: usize, b: usize| proj[a..=b].iter().sum::<u32>() as f64 >= (b - a + 1) as f64 * (xb - xa).max(1) as f64 * min_ink;
    let Some(one) = one else {
        return runs.into_iter().filter(|&(a, b)| (b - a + 1) as f64 >= min_h && dense(a, b)).map(|(a, b)| (ya + a as i64, ya + b as i64)).collect();
    };
    // 高过一行半的截先在深谷处切开：谷底的墨不到本截字身墨（九成分位）的二十分之一（连谱号的钩、贴边的残墨留下的那几个像素）
    let mut pieces: Vec<(usize, usize)> = Vec::new();
    for (a, b) in runs {
        if ((b - a + 1) as f64) < one * 1.5 {
            pieces.push((a, b));
            continue;
        }
        let mut vals: Vec<f64> = proj[a..=b].iter().map(|&v| v as f64).collect();
        vals.sort_by(f64::total_cmp);
        let floor = vals[(vals.len() * 9 / 10).min(vals.len() - 1)] / 20.0;
        let mut from = a;
        let mut i = a;
        while i <= b {
            if proj[i] as f64 > floor {
                i += 1;
                continue;
            }
            let v0 = i;
            while i <= b && proj[i] as f64 <= floor {
                i += 1;
            }
            // 切下的两边都得够半行字高（一个字顶上伸出的一笔、行间的残墨不单成一截）
            if v0 > from && i <= b && (v0 - from) as f64 >= one * 0.5 && (b + 1 - i) as f64 >= one * 0.5 {
                pieces.push((from, v0 - 1));
                from = i;
            }
        }
        pieces.push((from, b));
    }
    let mut out = Vec::new();
    for (a, b) in pieces {
        let hh = (b - a + 1) as f64;
        if std::env::var("OMR_JP_DEBUG").is_ok() {
            eprintln!("  截 y{}-{} 高{hh} 密{}", ya + a as i64, ya + b as i64, dense(a, b));
        }
        if hh < min_h || !dense(a, b) {
            continue;
        }
        let k = (hh / one).round() as usize;
        if hh > one * 1.7 && k >= 2 {
            // 挤在一起的几行：在各等分点附近投影最小处切
            let mut from = a;
            for j in 1..k {
                let t = a + (b - a) * j / k;
                let r = (one * 0.3) as usize;
                let cut = (t.saturating_sub(r)..=(t + r).min(b)).min_by_key(|&y| proj[y]).unwrap_or(t);
                out.push((ya + from as i64, ya + cut as i64));
                from = cut + 1;
            }
            out.push((ya + from as i64, ya + b as i64));
        } else {
            out.push((ya + a as i64, ya + b as i64));
        }
    }
    out
}

/// 读一行：行里的墨按宽空当分段，各段从灰度图取条送 rec，字位折回页内坐标、补词间空格；段与段之间隔一个空格。
fn read_line(ink: &Ink, claims: &Claims, ocr: &CachedOcr, slope: f64, y0: i64, y1: i64, xa: i64, xb: i64, doubts: Option<&mut Vec<f64>>) -> Vec<Ch> {
    let mut out: Vec<Ch> = Vec::new();
    for seg in read_segs(ink, claims, ocr, slope, y0, y1, xa, xb, doubts) {
        if let Some(l) = out.last() {
            let x = l.x1;
            out.push(Ch { ch: ' ', x0: x, x1: x });
        }
        out.extend(seg);
    }
    out
}

/// 歌词字复核的门：OCR 第一名比第二名高不了这么多（logit 差）就算把握不大（TS `omr/jianpu.ts::LYRIC_DOUBT_MARGIN` 同值）。
pub const LYRIC_DOUBT_MARGIN: f32 = 0.7;

/// 同 [`read_line`]，各段分开回。`doubts` 给了：再取逐字前两名（同一条画面，走内容缓存），把握不大的汉字的中心 x 记进去。
fn read_segs(ink: &Ink, claims: &Claims, ocr: &CachedOcr, slope: f64, y0: i64, y1: i64, xa: i64, xb: i64, mut doubts: Option<&mut Vec<f64>>) -> Vec<Vec<Ch>> {
    let w = ink.w() as i64;
    let hh = (y1 - y0 + 1) as f64;
    let shift = |x: i64| (slope * (x - w / 2) as f64).round() as i64;
    let col = |x: i64| (y0..=y1).any(|y| claims.free(ink, x, y + shift(x)));
    // 有墨的列段
    let mut spans: Vec<(i64, i64)> = Vec::new();
    let mut x = xa.max(0);
    while x < xb.min(w) {
        if !col(x) {
            x += 1;
            continue;
        }
        let a = x;
        while x < xb.min(w) && col(x) {
            x += 1;
        }
        spans.push((a, x - 1));
    }
    // 隔着 1.6 行高以上空当的分成两段
    let mut segs: Vec<Vec<(i64, i64)>> = Vec::new();
    for s in spans {
        match segs.last_mut() {
            Some(g) if (s.0 - g.last().unwrap().1) as f64 <= hh * 1.6 => g.push(s),
            _ => segs.push(vec![s]),
        }
    }
    let mut out: Vec<Vec<Ch>> = Vec::new();
    for g in segs {
        let (sa, sb) = (g[0].0, g.last().unwrap().1);
        if ((sb - sa + 1) as f64) < hh * 0.25 {
            continue;
        }
        let mid = (sa + sb) / 2;
        let rect = Rect::new(sa as f64, (y0 + shift(mid)) as f64, (sb - sa + 1) as f64, hh);
        let pad = (hh * 0.12).ceil() as i64;
        let strip = ink.strip(&rect, pad);
        let Ok(got) = ocr.read_line(&strip) else { continue };
        let sw = strip.w as f64;
        let x_left = sa as f64 - pad as f64;
        if let Some(d) = doubts.as_deref_mut() {
            // 排名与贪心解码按同一套分段，逐个对上；对不上（个数不同）就不判
            if let Ok(rk) = ocr.rank_chars(&strip, 2) {
                if rk.len() == got.len() {
                    for (c, r) in got.iter().zip(&rk) {
                        let mut it = c.ch.chars();
                        let (Some(ch), None) = (it.next(), it.next()) else { continue };
                        if !is_han(ch) || r.alts.is_empty() {
                            continue;
                        }
                        let margin = r.scores.first().copied().unwrap_or(1.0) - r.scores.get(1).copied().unwrap_or(0.0);
                        if r.alts[0] != c.ch || margin < LYRIC_DOUBT_MARGIN {
                            d.push(x_left + (c.x0 + c.x1) / 2.0 * sw);
                        }
                    }
                }
            }
        }
        let mut chars: Vec<Ch> = Vec::new();
        for c in got {
            let cs: Vec<char> = c.ch.chars().collect();
            let (a, b) = (x_left + c.x0 * sw, x_left + c.x1 * sw);
            let n = cs.len().max(1) as f64;
            for (i, ch) in cs.into_iter().enumerate() {
                chars.push(Ch { ch: fold(ch), x0: a + (b - a) * i as f64 / n, x1: a + (b - a) * (i + 1) as f64 / n });
            }
        }
        if chars.is_empty() {
            continue;
        }
        let blanks: Vec<(f64, f64)> = g.windows(2).map(|p| ((p[0].1 + 1) as f64, (p[1].0 - p[0].1 - 1) as f64)).collect();
        out.push(recover_spaces(&chars, &blanks, hh, sa as f64, (sb + 1) as f64));
    }
    out
}

const CN_NUM: &str = "一二三四五六七八九十";

/// 行首的边注：汉字段号（`一`、`二、`）与「副」「(副)」，印在首音左边。回 (段号, 去掉边注后的字)。
fn margin_label(chars: &[Ch], first_x: f64, h: f64) -> (Option<String>, &[Ch]) {
    let mut i = 0;
    while chars.get(i).is_some_and(|c| "(（ ".contains(c.ch)) {
        i += 1;
    }
    let Some(c) = chars.get(i) else { return (None, chars) };
    if !(CN_NUM.contains(c.ch) || c.ch == '副') || c.cx() > first_x - h * 0.4 {
        return (None, chars);
    }
    let mut j = i + 1;
    // 「副一」「副歌」这类两个字的边注
    if c.ch == '副' && chars.get(j).is_some_and(|d| (CN_NUM.contains(d.ch) || d.ch == '歌') && d.cx() < first_x - h * 0.4) {
        j += 1;
    }
    while chars.get(j).is_some_and(|c| ")）、.．:： ".contains(c.ch)) {
        j += 1;
    }
    if !chars.get(j).is_some_and(|c| is_han(c.ch) || "“‘\"".contains(c.ch)) {
        return (None, chars);
    }
    ((c.ch != '副').then(|| c.ch.to_string()), &chars[j..])
}


/// 全角拉丁字母、数字折半角（中文标点不动）。
fn fold(c: char) -> char {
    match c {
        '０'..='９' | 'Ａ'..='Ｚ' | 'ａ'..='ｚ' => char::from_u32(c as u32 - 0xFEE0).unwrap_or(c),
        '＃' => '#',
        c => c,
    }
}

/// 一行谱的歌词在横向上的范围：词不出行的左右太远（左边留出段号的地方），与短行同排的谱旁附注不收。
fn lyric_span(ink: &Ink, row: &RowFrame) -> (i64, i64) {
    let h = row.h();
    match (row.cells.first(), row.cells.last()) {
        (Some(a), Some(b)) => ((a.x0 as f64 - h * 3.0).max(0.0) as i64, ((b.x1 as f64 + h * 2.0) as i64).min(ink.w() as i64)),
        _ => (0, ink.w() as i64),
    }
}

/// 各谱行下面的歌词：切行、读字、对音，写进各音的 `lyrics` 与行的段号。回各行歌词带的行（供叠加与排查）。
/// `stanza_regions`：谱后附段落到音上的那几段，各行原文与源框（识别模式按原位叠加）。
pub fn lyrics(ink: &Ink, rows: &[RowFrame], notes: &mut [RowNotes], labels: &mut [Vec<String>], ocr: &CachedOcr, regions: &mut Vec<TextRegion>, stanza_regions: &mut Vec<TextRegion>) {
    let w = ink.w() as f64;
    let num_h0 = median(&rows.iter().map(|r| r.h()).collect::<Vec<_>>(), 0.0);
    let claims = Claims::new(ink, notes.iter().flat_map(|n| n.claimed.iter().copied())).tall_runs(ink, num_h0 * 2.2);
    let mut max_verses = 0usize;
    // 歌词带里读到的跳转记号：(行, 记号, x, y)
    let mut jumps: Vec<(usize, &'static str, f64, f64)> = Vec::new();
    // 各行歌词头一行顶离谱行底的距离
    let mut first_gaps: Vec<f64> = Vec::new();
    let mut stanza_lines: Vec<(i64, i64)> = Vec::new();
    let zone = |i: usize| {
        let ya = rows[i].bottom_at(w / 2.0).ceil() as i64 + 1;
        let yb = if i + 1 == rows.len() { ink.h() as i64 } else { rows[i + 1].top_at(w / 2.0).floor() as i64 };
        (ya, yb)
    };
    // 本页一行字的高：各词带里够高够密的墨截的中位高（两行挤成一截的、弧与点凑的一截都是少数）
    let all: Vec<f64> = (0..rows.len())
        .flat_map(|i| {
            let (ya, yb) = zone(i);
            // 歌词字不比数字小多少：矮的一截（减时线没认全剩下的、弧与点凑的）不参加估行高
            let h = rows[i].h();
            cut_lines(ink, &claims, rows[i].band.slope, ya, yb, lyric_span(ink, &rows[i]), h * 0.5, None).into_iter().map(|l| (l.1 - l.0 + 1) as f64).filter(move |&v| v >= h * 0.9)
        })
        .collect();
    let num_h = median(&rows.iter().map(|r| r.h()).collect::<Vec<_>>(), 0.0);
    // 几行挤成一截的把中位拉高：取偏矮的分位，且不过 1.8 字号
    let one = if all.is_empty() { num_h * 1.25 } else { dolce_omr_core::geom::quantile(&all, 0.3).min(num_h * 1.8) };
    for i in 0..rows.len() {
        let row = &rows[i];
        let h = row.h();
        let (ya, yb) = zone(i);
        let last = i + 1 == rows.len();
        let (xa, xb) = lyric_span(ink, row);
        let mut lines = cut_lines(ink, &claims, row.band.slope, ya, yb, (xa, xb), h * 0.5, (one > 0.0).then_some(one));
        if last {
            // 谱后：只收紧跟着的几行（行距不过一行高），至多收到前面各行见过的段数
            // 段数从头一截够一行字高的数起：贴着谱行的低音点、没认全的减时线凑成的矮截不占名额
            let (mut keep, mut full) = (0, 0);
            for (k, l) in lines.iter().enumerate() {
                let gap = if k == 0 { l.0 - ya } else { l.0 - lines[k - 1].1 };
                // 头一行离谱行的距离照前面各行歌词头一行的（本页排得疏的，词离谱行一个半字号开外）
                let reach = if k == 0 { (median(&first_gaps, 0.0) * 1.25).max(h * 1.6) } else { h * 1.6 };
                if gap as f64 > reach || (max_verses > 0 && full >= max_verses) {
                    break;
                }
                full += (full > 0 || ((l.1 - l.0 + 1) as f64) >= h * 0.9) as usize;
                keep = k + 1;
            }
            lines.truncate(keep);
            // 谱后的诗行另切一遍：独占一行的段号墨少，按字行的密度门进不来
            let from = lines.last().map_or(ya, |l| l.1 + 1);
            stanza_lines = cut_lines_at(ink, &claims, row.band.slope, from, yb, (0, ink.w() as i64), h * 0.25, (one > 0.0).then_some(one), LABEL_INK);
        }
        let note_ix: Vec<usize> = (0..notes[i].nums.len()).filter(|&k| notes[i].nums[k].digit != 0).collect();
        let note_xs: Vec<f64> = note_ix.iter().map(|&k| notes[i].nums[k].bbox.cx()).collect();
        let mut verse = 0usize;
        for (y0, y1) in lines {
            let mut doubt_xs: Vec<f64> = Vec::new();
            let mut chars: Vec<Ch> = Vec::new();
            for mut seg in read_segs(ink, &claims, ocr, row.band.slope, y0, y1, xa, xb, Some(&mut doubt_xs)) {
                // 跳转记号（Fine、D.S. al Fine）不是词：记下位置挂到音上，从行里拿掉
                if let Some((word, x, keep)) = jump_in(&seg) {
                    jumps.push((i, word, x, (y0 + y1) as f64 / 2.0));
                    seg.truncate(keep);
                    if seg.iter().all(|c| c.ch == ' ') {
                        continue;
                    }
                }
                if let Some(l) = chars.last() {
                    let x = l.x1;
                    chars.push(Ch { ch: ' ', x0: x, x1: x });
                }
                chars.extend(seg);
            }
            let text: String = chars.iter().map(|c| c.ch).collect();
            if std::env::var("OMR_JP_DEBUG").is_ok() {
                eprintln!("行{i} 词带 y{y0}-{y1}: {text}");
            }
            // 下一行谱头顶上的和弦行、弧与点凑成的一截不是歌词
            let near_next = !last && (yb - y1) as f64 <= h * 1.3;
            let (cov, cnt) = chords::coverage(&text);
            let chordish = chords::is_chord_coverage(cov, cnt) && !text.chars().any(is_han);
            // 英文歌词：至少三个三字母以上的小写词（和弦行、跳转记号、段落名到不了）
            let words = text.split(|c: char| !c.is_ascii_lowercase()).filter(|w| w.len() >= 3).count();
            if (!last && chordish) || (near_next && han_count(&text) < 2 && words < 3) {
                continue;
            }
            // 没认全的减时线、弧凑成的一截：比一行字矮得多，或读出来只有横杠
            // 英文歌词行比汉字行矮，不按行高丢
            let junk = text.chars().filter(|&c| is_han(c)).all(|c| "一二三".contains(c))
                && ((((y1 - y0 + 1) as f64) < one * 0.75 && words < 3) || !text.chars().any(|c| c.is_ascii_alphabetic()));
            if junk || note_xs.is_empty() {
                continue;
            }
            // 弧、穿过弧的小节线、点凑出来的「字」：读出的汉字多，行里够一个字身大小的块却少（字至少有一块够半个字高）
            let han = han_count(&text);
            if han > 0 {
                let mid = w / 2.0;
                // 画在图框里的字（谱尾的徽标）不算：块落在一个比两行字还大的块的外框里
                let big: Vec<&Rect> = ink.comps().iter().filter(|k| k.rect.h >= one * 2.0 && k.rect.w >= one * 2.0).map(|k| &k.rect).collect();
                let blobs = ink
                    .comps()
                    .iter()
                    .filter(|k| {
                        let cy = k.cy - row.band.slope * (k.cx - mid);
                        cy >= y0 as f64 && cy <= y1 as f64 && k.rect.h >= one * 0.4 && k.rect.h <= one * 1.4 && k.rect.w <= one * 1.6
                    })
                    .filter(|k| !big.iter().any(|b| b.x <= k.rect.x && b.right() >= k.rect.right() && b.y <= k.rect.y && b.bottom() >= k.rect.bottom()))
                    .count();
                if blobs * 2 < han {
                    if std::env::var("OMR_JP_DEBUG").is_ok() {
                        eprintln!("  丢：字身块 {blobs}、汉字 {han}");
                    }
                    continue;
                }
            }
            let (margin, body) = margin_label(&chars, note_xs[0] - notes[i].nums[note_ix[0]].bbox.w / 2.0, h);
            let mut lr = syllables(body);
            if margin.is_some() {
                lr.label = margin;
            }
            if lr.syls.is_empty() {
                continue;
            }
            let at = align(&lr.syls.iter().map(|s| s.x).collect::<Vec<_>>(), &note_xs);
            for (s, &k) in lr.syls.iter().zip(&at) {
                let n = &mut notes[i].nums[note_ix[k]];
                if n.lyrics.len() <= verse {
                    n.lyrics.resize(verse + 1, String::new());
                }
                n.lyrics[verse].push_str(&s.text);
                // 音节的字墨范围里落着把握不大的字
                if s.text.chars().any(is_han) && doubt_xs.iter().any(|&x| (x - s.x).abs() <= s.w / 2.0 + 0.5) && !n.lyric_doubt.contains(&verse) {
                    n.lyric_doubt.push(verse);
                }
            }
            if labels[i].len() <= verse {
                labels[i].resize(verse + 1, String::new());
            }
            labels[i][verse] = lr.label.unwrap_or_default();
            if verse == 0 {
                first_gaps.push((y0 - ya) as f64);
            }
            regions.push(TextRegion { text, bbox: Rect::new(chars.first().map_or(0.0, |c| c.x0), y0 as f64, chars.last().map_or(0.0, |c| c.x1) - chars.first().map_or(0.0, |c| c.x0), (y1 - y0 + 1) as f64) });
            verse += 1;
        }
        max_verses = max_verses.max(verse);
    }
    // 跳转记号落位：作用于小节末，归 x 处或其左边最近的那个音；行按 y 就近取（`D.C. al Fine` 常印在下一行的右上方），印在音符带下方的记 below
    for (ri, word, x, y) in jumps {
        let mut r = ri;
        if r + 1 < rows.len() && rows[r + 1].top_at(x) - y < y - rows[r].bottom_at(x) {
            r += 1;
        }
        let nums = &mut notes[r].nums;
        if nums.is_empty() {
            continue;
        }
        let mut bi = nums.len() - 1;
        while bi > 0 && nums[bi].bbox.cx() > x {
            bi -= 1;
        }
        if !nums[bi].jump_marks.iter().any(|w| w == word) {
            nums[bi].jump_marks.push(word.to_string());
        }
        if y > rows[r].bottom_at(x) && !nums[bi].jump_below.iter().any(|w| w == word) {
            nums[bi].jump_below.push(word.to_string());
        }
    }
    stanzas(ink, &claims, rows, notes, labels, ocr, &stanza_lines, stanza_regions);
}

/// 一段字里的跳转记号：整段是记号，或含汉字的段末尾带一个写全的（`远。Fine`、`D.C.`）。
/// 回 (记号, 起始 x, 记号之前留几个字)。`D.S. al Fine` 记成 `D.S.`（同 TS `normalizeJump`：收尾 Fine 由写出端推）。
fn jump_in(seg: &[Ch]) -> Option<(&'static str, f64, usize)> {
    let text: String = seg.iter().map(|c| c.ch).collect();
    let m = chords::JUMP.find_iter(&text).next()?;
    let han = text.chars().any(is_han);
    let full = m.as_str().contains("Fine") || m.as_str().matches(['.', '·']).count() >= 2;
    let before = text[..m.start()].chars().count();
    let after = text[m.end()..].trim();
    if han && !(full && after.is_empty()) {
        return None;
    }
    if !han && !text[..m.start()].trim().is_empty() {
        return None;
    }
    let t: String = m.as_str().chars().filter(|c| !c.is_whitespace() && !".,·".contains(*c)).collect::<String>().to_uppercase();
    let word = if t.starts_with("FINE") {
        "Fine"
    } else if t.starts_with("TO") {
        "To Coda"
    } else if t.starts_with("DS") {
        "D.S."
    } else {
        "D.C."
    };
    Some((word, seg.get(before).map_or(0.0, |c| c.x0), before))
}

/// 谱后单独排版的附段歌词（诗行，不跟音符对齐）：以段号起头的一段，字数与第 1 段前几行谱的字位数对得上（差不过 2）时，
/// 按第 1 段的字位骨架逐字落到音上。分栏排的按栏从左到右、栏内从上到下读。
fn stanzas(ink: &Ink, claims: &Claims, rows: &[RowFrame], notes: &mut [RowNotes], labels: &mut [Vec<String>], ocr: &CachedOcr, lines: &[(i64, i64)], regions: &mut Vec<TextRegion>) {
    if lines.is_empty() || rows.is_empty() {
        return;
    }
    let slope = rows[rows.len() - 1].band.slope;
    let hh = median(&lines.iter().map(|l| (l.1 - l.0 + 1) as f64).collect::<Vec<_>>(), 1.0);
    // 各段文字，带栏位（段左缘）与行的上下沿
    let mut segs: Vec<(f64, i64, Vec<Ch>, i64)> = Vec::new();
    for &(y0, y1) in lines {
        for seg in read_segs(ink, claims, ocr, slope, y0, y1, 0, ink.w() as i64, None) {
            if std::env::var("OMR_JP_DEBUG").is_ok() {
                eprintln!("谱后 y{y0}: {}", seg.iter().map(|c| c.ch).collect::<String>());
            }
            if let Some(x) = seg.first().map(|c| c.x0) {
                segs.push((x, y0, seg, y1));
            }
        }
    }
    // 同一行里隔着不大空当的后一段是诗句中间断开的后半句（不是另一栏），接回左边那段——除非它以带分隔的段号起头
    let strict_start = |seg: &[Ch]| {
        let t: Vec<char> = seg.iter().map(|c| c.ch).filter(|c| !" (（".contains(*c)).collect();
        t.first().is_some_and(|c| CN_NUM.contains(*c) || c.is_ascii_digit()) && t.get(1).is_some_and(|c| "、.．:：)）".contains(*c) || c.is_ascii_digit())
    };
    segs.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.total_cmp(&b.0)));
    let mut kept: Vec<(f64, i64, Vec<Ch>, i64)> = Vec::new();
    for s in segs {
        match kept.last_mut() {
            Some(k) if k.1 == s.1 && s.0 - k.2.last().map_or(0.0, |c| c.x1) <= hh * 3.0 && !strict_start(&s.2) => {
                let x = k.2.last().map_or(0.0, |c| c.x1);
                k.2.push(Ch { ch: ' ', x0: x, x1: x });
                k.2.extend(s.2);
            }
            _ => kept.push(s),
        }
    }
    let mut segs = kept;
    // 分栏：左缘相差不过 3 行高的归一栏
    let mut cols: Vec<f64> = Vec::new();
    for s in &segs {
        if !cols.iter().any(|&c| (c - s.0).abs() <= hh * 3.0) {
            cols.push(s.0);
        }
    }
    cols.sort_by(f64::total_cmp);
    let col_of = |x: f64| cols.iter().position(|&c| (c - x).abs() <= hh * 3.0).unwrap_or(0);
    segs.sort_by(|a, b| col_of(a.0).cmp(&col_of(b.0)).then(a.1.cmp(&b.1)));
    // 谱里已有的段数（各音歌词段数的最大）
    let score_verses = notes.iter().flat_map(|rn| rn.nums.iter().map(|n| n.lyrics.len())).max().unwrap_or(1).max(1);
    // 以段号起头的切成段（带各行原文与源框）
    let mut blocks: Vec<(String, Vec<Ch>, Vec<TextRegion>)> = Vec::new();
    for (_, y0, seg, y1) in segs {
        let text: String = seg.iter().map(|c| c.ch).collect();
        let (xa, xb) = (seg.first().map_or(0.0, |c| c.x0), seg.last().map_or(0.0, |c| c.x1));
        let region = TextRegion { text: text.clone(), bbox: Rect::new(xa, y0 as f64, xb - xa, (y1 - y0 + 1) as f64) };
        if text.trim_start().starts_with("注") {
            break;
        }
        let lead = seg.iter().position(|c| c.ch != ' ' && c.ch != '(' && c.ch != '（').unwrap_or(0);
        let c0 = seg[lead].ch;
        let digits = seg[lead..].iter().take_while(|c| c.ch.is_ascii_digit()).count();
        // 段号独占一行的（「二」底下才是诗行）也起一段
        let alone = seg[lead + 1..].iter().all(|c| " 、.．:：)）".contains(c.ch));
        // 汉字段号后面跟着分隔（「二、」「三.」）或独占一行；直接粘着诗行的（「二我虽忘祂」）得是接下来该到的那个段号——
        // 诗行本身常以「一」起头（「一面运行」）。头一段该到的是谱里已有段数的下一个
        let cn_sep = seg.get(lead + 1).is_some_and(|c| " 、.．:：)）".contains(c.ch));
        let cn: Vec<char> = CN_NUM.chars().collect();
        let expect = match blocks.last() {
            Some(b) => b.0.chars().next().and_then(|c| cn.iter().position(|&d| d == c)).map(|k| k + 1),
            None => Some(score_verses),
        };
        let glued = expect.and_then(|k| cn.get(k)).is_some_and(|&c| c == c0);
        let label = if CN_NUM.contains(c0) && ((seg.len() > lead + 2 && (cn_sep || glued)) || alone) {
            Some((c0.to_string(), lead + 1))
        } else if (1..=2).contains(&digits) && seg.get(lead + digits).is_some_and(|c| ".．、 ".contains(c.ch) || is_han(c.ch)) {
            Some((seg[lead..lead + digits].iter().map(|c| c.ch).collect::<String>() + if seg[lead + digits].ch == '.' { "." } else { "" }, lead + digits))
        } else {
            None
        };
        match label {
            Some((l, n)) => {
                let mut body = &seg[n..];
                while body.first().is_some_and(|c| ")）、.．:： ".contains(c.ch)) {
                    body = &body[1..];
                }
                blocks.push((l, body.to_vec(), vec![region]));
            }
            None => {
                if let Some(b) = blocks.last_mut() {
                    b.1.push(Ch { ch: ' ', x0: 0.0, x1: 0.0 });
                    b.1.extend(seg);
                    b.2.push(region);
                }
            }
        }
    }
    // 第 1 段的字位骨架：各行里第 1 段有字的音
    let slots: Vec<Vec<usize>> = notes.iter().map(|rn| (0..rn.nums.len()).filter(|&k| rn.nums[k].lyrics.first().is_some_and(|t| !t.is_empty())).collect()).collect();
    let base = notes.iter().find(|rn| !rn.nums.is_empty()).map_or(1, |rn| rn.nums.iter().map(|n| n.lyrics.len()).max().unwrap_or(1)).max(1);
    for (bi, (label, chars, rs)) in blocks.iter().enumerate() {
        let syls = syllables(chars).syls;
        let n = syls.len();
        // 取前几行谱：字位数的累计最接近这段的字数
        let mut sum = 0usize;
        let mut best: Option<(usize, usize)> = None;
        for (ri, s) in slots.iter().enumerate() {
            sum += s.len();
            if best.is_none_or(|b| sum.abs_diff(n) < b.1) {
                best = Some((ri, sum.abs_diff(n)));
            }
        }
        let Some((upto, diff)) = best else { continue };
        if diff > 2 || n < 4 {
            continue;
        }
        let v = base + bi;
        regions.extend(rs.iter().cloned());
        let mut k = 0;
        'rows: for ri in 0..=upto {
            for &ni in &slots[ri] {
                let Some(s) = syls.get(k) else { break 'rows };
                let num = &mut notes[ri].nums[ni];
                if num.lyrics.len() <= v {
                    num.lyrics.resize(v + 1, String::new());
                }
                num.lyrics[v] = s.text.clone();
                k += 1;
            }
        }
        if let Some(ri) = (0..=upto).find(|&ri| !slots[ri].is_empty()) {
            if labels[ri].len() <= v {
                labels[ri].resize(v + 1, String::new());
            }
            labels[ri][v] = label.clone();
        }
    }
}

static KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"1\s*[=＝]\s*([b♭#♯降升]?)\s*([A-Ga-g])").unwrap());
/// 不写「1=」的调名：`D4/4`、`bE 4/4`、`G调6/8`、小调 `Em3/4`（后面紧跟拍号或「调」字才认）。
static KEY_BARE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*([b♭#♯]?)([A-G])([b♭#♯]?)(m?)\s*(?:[/／]\s*[b♭#♯]?[A-G][b♭#♯]?\s*)?(?:调|大调|\d{1,2}\s*[/／]\s*\d)").unwrap());
static METER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d{1,2})\s*[/／]\s*(16|2|4|8)").unwrap());
/// 标题框开头的曲号：数字后面直接接汉字曲名。
static TITLE_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(\d{1,4})\s*([一-鿿].*)$").unwrap());
/// 书眉：书名后接曲号（`青年诗歌—015`），曲号去掉前导零。
static BOOK_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[一-鿿]{2,8}\s*[—\-－–_]*\s*0*(\d{1,4})\s*$").unwrap());
static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(\d{1,4})\s*[.．、]?\s*$").unwrap());

/// 调名 → 五度圈位置。
fn fifths_of(letter: char, alter: i32) -> i32 {
    let base = match letter.to_ascii_uppercase() {
        'C' => 0,
        'G' => 1,
        'D' => 2,
        'A' => 3,
        'E' => 4,
        'B' => 5,
        _ => -1,
    };
    base + alter * 7
}

/// 页眉：首行谱以上。DBNet 检出文本行，逐行读字；调号、拍号、速度、曲号按内容认，其余交 `omr-text` 分标题与署名。
pub fn header(ink: &Ink, rows: &[RowFrame], num_h: f64, ocr: &CachedOcr, score: &mut RecognizedScore) {
    let w = ink.w() as f64;
    let top = rows[0].top_at(w / 2.0);
    let zone = Rect::new(0.0, 0.0, w, (top - num_h * 0.3).max(1.0));
    let crop = ink.strip(&zone, 0);
    let boxes = ocr.detect(&crop).unwrap_or_default();
    let mut lines: Vec<WordLine> = Vec::new();
    let none = Claims::new(ink, std::iter::empty());
    for b in boxes {
        if b.h < num_h * 0.35 {
            continue;
        }
        let strip = ink.strip(&b, 0);
        let Ok(got) = ocr.read_line(&strip) else { continue };
        // 补词间空格（rec 不吐空格，`YouhavemadeapromisetotheLord`）：按框里的空白列；署名里名字与职能词之间的空当照谱面补
        let sw = strip.w as f64;
        let mut chars: Vec<Ch> = Vec::new();
        for c in &got {
            let cs: Vec<char> = c.ch.chars().map(fold).collect();
            let (a, z) = (b.x + c.x0 * sw, b.x + c.x1 * sw);
            let n = cs.len().max(1) as f64;
            for (i, ch) in cs.into_iter().enumerate() {
                chars.push(Ch { ch, x0: a + (z - a) * i as f64 / n, x1: a + (z - a) * (i + 1) as f64 / n });
            }
        }
        let chars = box_spaces(ink, &none, &b, &chars);
        let mut text: String = chars.iter().map(|c| c.ch).collect();
        if CREDIT_ROLE.is_match(&text) {
            text = han_gaps(&chars, b.h);
        }
        if std::env::var("OMR_JP_DEBUG").is_ok() {
            eprintln!("页眉 {:.0},{:.0} {:.0}x{:.0}: {text}", b.x, b.y, b.w, b.h);
        }
        // 首行谱头顶上的和弦行不是页眉
        if top - (b.y + b.h) <= num_h * 3.0 && chords::is_annotation_line(&text) {
            continue;
        }
        if !text.trim().is_empty() {
            lines.push(WordLine { text, x: b.x, y: b.y, w: b.w, h: b.h });
        }
    }
    // det 把一行切成几框的（「祂來」|「過」、「泥土音乐《脚步》」|「（2007）」）：同高、同一横排、挨着的并回一行
    lines.sort_by(|a, b| a.x.total_cmp(&b.x));
    let mut joined: Vec<WordLine> = Vec::new();
    for l in lines {
        let hit = joined.iter_mut().find(|j| {
            let ov = (j.y + j.h).min(l.y + l.h) - j.y.max(l.y);
            let hh = j.h.min(l.h);
            // 切开的框是叠着或贴着的（隔开的是两行字：曲号与标题、署名与副标题）
            ov >= hh * 0.6 && (j.h - l.h).abs() <= hh * 0.3 && l.x - (j.x + j.w) <= hh * 0.1 && l.x - (j.x + j.w) >= -hh && !NUMBER.is_match(&j.text) && !NUMBER.is_match(&l.text)
        });
        match hit {
            Some(j) => {
                let latin = j.text.chars().last().is_some_and(|c| c.is_ascii_alphanumeric()) && l.text.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
                j.text = format!("{}{}{}", j.text, if latin { " " } else { "" }, l.text);
                let (x1, y1) = ((j.x + j.w).max(l.x + l.w), (j.y + j.h).max(l.y + l.h));
                j.y = j.y.min(l.y);
                j.w = x1 - j.x;
                j.h = y1 - j.y;
            }
            None => joined.push(l),
        }
    }
    let lines = joined;
    // 曲号不比标题小多少（拍号的分子、速度数字小得多）
    let max_h = lines.iter().map(|l| l.h).fold(0.0, f64::max);
    // 标题：不是书眉、曲号的行里最大的那行
    let plain = || lines.iter().filter(|l| !BOOK_NUMBER.is_match(&l.text) && !NUMBER.is_match(&l.text));
    let title_h = plain().map(|l| l.h).fold(0.0, f64::max);
    let title_y = plain().find(|l| l.h == title_h).map_or(0.0, |l| l.y);
    let mut rest: Vec<WordLine> = Vec::new();
    let mut number: Option<(String, f64, f64)> = None;
    for l in lines {
        // 书眉「青年诗歌—015」「青年诗歌073」：书名带曲号，记曲号、不当标题
        if let Some(c) = BOOK_NUMBER.captures(&l.text) {
            // 书眉在页顶：整行在最大那行字（标题）顶上（署名「戴克斯曲1861」「合译1932」与标题同排或在下面）
            if l.y + l.h <= title_y {
                if number.as_ref().is_none_or(|n| n.2 < l.h) {
                    // 书眉里的曲号不记印在哪侧（不是标题旁的曲号）
                    number = Some((c[1].to_string(), f64::NAN, l.h));
                }
                continue;
            }
        }
        let mut used = false;
        if let Some(c) = KEY.captures(&l.text) {
            let alter = match &c[1] {
                "b" | "♭" | "降" => -1,
                "#" | "♯" | "升" => 1,
                _ => 0,
            };
            let letter = c[2].chars().next().unwrap().to_ascii_uppercase();
            score.fifths = fifths_of(letter, alter);
            score.key = format!("{letter}{}", if alter < 0 { "b" } else if alter > 0 { "#" } else { "" });
            used = true;
        }
        if !used {
            if let Some(c) = KEY_BARE.captures(&l.text) {
                let alt = |t: &str| match t {
                    "b" | "♭" => -1,
                    "#" | "♯" => 1,
                    _ => 0,
                };
                let alter = alt(&c[1]) + alt(&c[3]);
                let letter = c[2].chars().next().unwrap();
                let minor = &c[4] == "m";
                // 小调记关系大调的升降号数
                score.fifths = fifths_of(letter, alter) - if minor { 3 } else { 0 };
                score.minor = minor;
                score.key = format!("{letter}{}{}", if alter < 0 { "b" } else if alter > 0 { "#" } else { "" }, if minor { "m" } else { "" });
                used = true;
            }
        }
        // 并排印着几个拍号的是混合拍：头一个作主拍号，全部记进 `meters`；后面跟着的「混合拍」记说明
        let mut first = true;
        for c in METER.captures_iter(&l.text) {
            if let (Ok(a), Ok(b)) = (c[1].parse::<u32>(), c[2].parse::<u32>()) {
                if (1..=12).contains(&a) && [2, 4, 8, 16].contains(&b) {
                    if std::mem::take(&mut first) {
                        score.beats = a;
                        score.beat_type = b;
                        score.meters.clear();
                    }
                    if !score.meters.iter().any(|m| m.beats == a && m.beat_type == b) {
                        score.meters.push(TimeSig { beats: a, beat_type: b });
                    }
                    score.meter_read = true;
                    used = true;
                    if l.text.contains("混合拍") {
                        score.meter_note = Some("混合拍".into());
                    }
                }
            }
        }
        if let Some((bpm, _)) = words::metronome(&l.text) {
            score.tempo = Some(bpm);
            used = true;
        }
        if let Some(c) = NUMBER.captures(&l.text) {
            if l.h >= num_h * 0.6 && l.h >= max_h * 0.6 && number.as_ref().is_none_or(|n| n.2 < l.h) {
                number = Some((c[1].trim_start_matches('0').to_string(), l.x + l.w / 2.0, l.h));
            }
            used = true;
        }
        if !used {
            rest.push(l);
        }
    }
    stacked_meter(ink, top, num_h, ocr, score);
    let cs = credits(&rest, 0.0, w);
    let title = cs.iter().find(|c| c.kind == Some(CreditType::Title));
    if let Some(t) = title {
        score.title = Some(t.text.clone());
        // 曲号与曲名印在一个框里（「1771你曾向主许下」）：开头的数字是曲号
        if let Some(c) = TITLE_NUMBER.captures(&t.text) {
            if number.is_none() {
                number = Some((c[1].to_string(), f64::NEG_INFINITY, t.rect.3));
            }
            score.title = Some(c[2].to_string());
        }
        for c in &cs {
            match c.kind {
                Some(CreditType::Title) if !std::ptr::eq(c, t) && score.subtitle.is_none() => score.subtitle = Some(c.text.clone()),
                Some(CreditType::Subtitle) if score.subtitle.is_none() => score.subtitle = Some(c.text.clone()),
                Some(CreditType::Composer) | Some(CreditType::Lyricist) => {
                    // 印在标题左边、不低于标题的署名记左上
                    let left_of = c.rect.0 + c.rect.2 <= t.rect.0 && c.rect.1 + c.rect.3 / 2.0 <= t.rect.1 + t.rect.3;
                    if left_of { score.credits_top_left.push(c.text.clone()) } else { score.credits.push(c.text.clone()) }
                }
                _ => {}
            }
            score.header_regions.push(TextRegion { text: c.text.clone(), bbox: Rect::new(c.rect.0, c.rect.1, c.rect.2, c.rect.3) });
        }
        if let Some((n, x, _)) = number {
            if !x.is_nan() {
                score.number_side = Some(if x > t.rect.0 + t.rect.2 / 2.0 { "right" } else { "left" });
            }
            score.number = Some(n);
        }
    } else if let Some((n, _, _)) = number {
        score.number = Some(n);
    }
}

/// 框里的字按框里的空白列补词间空格（同 `read_segs` 的读法，字由整框一次 rec 给出）。
fn box_spaces(ink: &Ink, none: &Claims, b: &Rect, chars: &[Ch]) -> Vec<Ch> {
    let (x0, x1) = (b.x.floor().max(0.0) as i64, ((b.x + b.w).ceil() as i64).min(ink.w() as i64));
    let (y0, y1) = (b.y.floor().max(0.0) as i64, ((b.y + b.h).ceil() as i64).min(ink.h() as i64) - 1);
    let col = |x: i64| (y0..=y1).any(|y| none.free(ink, x, y));
    let spans: Vec<i64> = (x0..x1).filter(|&x| col(x)).collect();
    let (Some(&ia), Some(&ib)) = (spans.first(), spans.last()) else { return chars.to_vec() };
    let mut blanks: Vec<(f64, f64)> = Vec::new();
    for p in spans.windows(2) {
        if p[1] > p[0] + 1 {
            blanks.push(((p[0] + 1) as f64, (p[1] - p[0] - 1) as f64));
        }
    }
    let rows: Vec<i64> = (y0..=y1).filter(|&y| (ia..=ib).any(|x| none.free(ink, x, y))).collect();
    let ink_h = match (rows.first(), rows.last()) {
        (Some(a), Some(z)) => (z - a + 1) as f64,
        _ => b.h,
    };
    if std::env::var("OMR_JP_DEBUG").is_ok() {
        eprintln!("  框空白 墨高{ink_h} {:?}", blanks.iter().map(|b| b.1 as i64).collect::<Vec<_>>());
    }
    recover_spaces(chars, &blanks, ink_h, ia as f64, (ib + 1) as f64)
}

/// 署名行里的职能词（有它才在汉字之间按空当补空格）。
static CREDIT_ROLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[词詞曲译譯编編]").unwrap());

/// 汉字与汉字之间的空当比本行字间白的中位宽出一倍、又不窄于四分之一字高的，补一个空格（「盛晓玫 词曲」「刘廷芳 杨荫浏」）。
fn han_gaps(chars: &[Ch], h: f64) -> String {
    let pairs: Vec<f64> = chars.windows(2).filter(|p| is_han(p[0].ch) && is_han(p[1].ch)).map(|p| p[1].x0 - p[0].x1).collect();
    let med = median(&pairs, 0.0).max(0.0);
    let mut out = String::new();
    for (i, c) in chars.iter().enumerate() {
        if i > 0 {
            let p = &chars[i - 1];
            let gap = c.x0 - p.x1;
            if is_han(p.ch) && is_han(c.ch) && gap >= h * 0.25 && gap >= med * 2.0 + 1.0 {
                out.push(' ');
            }
        }
        out.push(c.ch);
    }
    out
}

/// 叠排的拍号：上下两个数字、横向对齐、中间隔一道横线的空当。只在行内文字没读出 `4/4` 时用。
fn stacked_meter(ink: &Ink, top: f64, num_h: f64, ocr: &CachedOcr, score: &mut RecognizedScore) {
    let digitish: Vec<&crate::prep::Comp> = ink.comps().iter().filter(|k| k.rect.bottom() < top && k.rect.h >= num_h * 0.5 && k.rect.h <= num_h * 1.4 && k.rect.w >= k.rect.h * 0.3 && k.rect.w <= k.rect.h * 1.0).collect();
    // (上面那个数字的 y, 中线 x, 分子, 分母)
    let mut found: Vec<(f64, f64, u32, u32)> = Vec::new();
    for a in &digitish {
        for b in &digitish {
            let gap = b.rect.y - a.rect.bottom();
            if gap < num_h * 0.05 || gap > num_h * 0.6 || (a.rect.cx() - b.rect.cx()).abs() > num_h * 0.3 || (a.rect.h - b.rect.h).abs() > a.rect.h * 0.25 {
                continue;
            }
            let Ok(t) = ocr.read_cells(&[digit_cell(ink, &a.rect), digit_cell(ink, &b.rect)]) else { continue };
            let d = |s: &str| s.trim().parse::<u32>().ok();
            if let (Some(x), Some(y)) = (d(&t[0]), d(&t[1])) {
                // 分子读成 8 的按 3（分子几乎不可能是 8），分母只可能是 2 的幂
                let x = if x == 8 { 3 } else { x };
                if (1..=12).contains(&x) && [2, 4, 8].contains(&y) {
                    found.push((a.rect.y, a.rect.cx(), x, y));
                }
            }
        }
    }
    // 取最靠下的那一排；同一排并排几个的是混合拍
    let Some(y0) = found.iter().map(|f| f.0).reduce(f64::max) else { return };
    found.retain(|f| y0 - f.0 < num_h * 0.5);
    found.sort_by(|a, b| a.1.total_cmp(&b.1));
    score.beats = found[0].2;
    score.beat_type = found[0].3;
    score.meter_read = true;
    score.meters.clear();
    for f in &found {
        let m = TimeSig { beats: f.2, beat_type: f.3 };
        if !score.meters.contains(&m) {
            score.meters.push(m);
        }
    }
}

/// 一行谱头顶上的和弦行：上方带里切行读字，整行是和弦记号的，各记号按左缘挂到它底下（或左边最近）的音上；
/// 一个音上已有和弦的记成这个音时值内后面换的和弦。
pub fn chords_above(ink: &Ink, row: &RowFrame, rn: &mut RowNotes, ocr: &CachedOcr, y_min: f64, regions: &mut Vec<TextRegion>) {
    let h = row.h();
    let w = ink.w() as f64;
    let top = row.top_at(w / 2.0);
    let ya = y_min.max(top - h * 2.8).max(0.0) as i64;
    let yb = top.floor() as i64 - 1;
    if rn.nums.is_empty() {
        return;
    }
    let claims = Claims::new(ink, std::iter::empty());
    for (y0, y1) in cut_lines(ink, &claims, row.band.slope, ya, yb, (0, ink.w() as i64), h * 0.35, None) {
        let chars = read_line(ink, &claims, ocr, row.band.slope, y0, y1, 0, ink.w() as i64, None);
        let text: String = chars.iter().map(|c| c.ch).collect();
        if std::env::var("OMR_JP_DEBUG").is_ok() {
            eprintln!("上方带 y{y0}-{y1}: {text}");
        }
        // 升号印在小写 m 后面的小调和弦（「Fm♯」= F♯m）：♯ 后面是空格或行末的，原地换成 `#m`（字数不变，下标对得上）
        let mut cs: Vec<char> = text.chars().collect();
        for i in 1..cs.len().saturating_sub(1) {
            if cs[i] == 'm' && "#♯".contains(cs[i + 1]) && ('A'..='G').contains(&cs[i - 1]) && cs.get(i + 2).is_none_or(|c| c.is_whitespace()) {
                cs.swap(i, i + 1);
            }
        }
        let text: String = cs.into_iter().collect();
        // 括号里的备选和弦（移调的另一套）不收
        let mut depth = 0;
        let no_paren: String = text
            .chars()
            .map(|c| {
                if "(（".contains(c) {
                    depth += 1;
                }
                let r = if depth > 0 { ' ' } else { c };
                if ")）".contains(c) && depth > 0 {
                    depth -= 1;
                }
                r
            })
            .collect();
        let clean = chords::blank_non_chord(&no_paren);
        let (cov, cnt) = chords::coverage(&clean);
        if !chords::is_chord_coverage(cov, cnt) || text.chars().any(is_han) {
            continue;
        }
        let x_at = |i: usize| chars.get(i).map_or(0.0, |c| c.x0);
        for t in chords::split_tokens(&clean, Some(&x_at)) {
            let x = x_at(t.index);
            let tok = chords::normalize(&t.tok);
            let k = rn.nums.iter().rposition(|n| n.bbox.x <= x + h * 0.4).unwrap_or(0);
            let next_x = rn.nums.get(k + 1).map_or(rn.nums[k].bbox.x + h * 4.0, |n| n.bbox.x);
            let n = &mut rn.nums[k];
            let x1 = chars.get(t.index + t.tok.chars().count() - 1).map_or(x, |c| c.x1);
            regions.push(TextRegion { text: tok.clone(), bbox: Rect::new(x, y0 as f64, x1 - x, (y1 - y0 + 1) as f64) });
            if n.chord.is_none() {
                n.chord = Some(tok);
            } else {
                let offset = ((x - n.bbox.x) / (next_x - n.bbox.x).max(1.0)).clamp(0.0, 0.99);
                n.extra_chords.push(crate::result::ExtraChord { tok, offset });
            }
        }
    }
}
