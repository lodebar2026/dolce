//! JM2 / JM4 文字：谱行之间的歌词行（切行、分段取条送 rec、对到音上）、页眉（标题、署名、曲号、调号、拍号、速度）。
//!
//! 行按像素的纵向投影切（顺着行带的斜率投影），已归了音符的墨（减时线、低音点）不算字。
//! 字的分类、切音节、对音、页眉分类用 `omr-text`（与五线谱路线同一份）。
use crate::frame::{digit_cell, RowFrame};
use crate::notes::RowNotes;
use crate::prep::{Comp, Ink};
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
    /// 只占这些块自己的墨（外框里别的块不占：弧的外框盖进相邻的和弦字，按框占会把字抹掉半边）。
    pub fn comps<'a>(ink: &Ink, comps: impl Iterator<Item = &'a Comp>) -> Claims {
        let (w, h) = (ink.w(), ink.h());
        let mut mask = vec![0u8; w * h];
        for c in comps {
            let r = &c.rect;
            for y in (r.y.max(0.0) as usize)..(r.bottom().ceil() as usize).min(h) {
                for x in (r.x.max(0.0) as usize)..(r.right().ceil() as usize).min(w) {
                    if ink.owns(c, x as i64, y as i64) {
                        mask[y * w + x] = 1;
                    }
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

/// 弧顶粘着上方的字（和弦字母的脚立在弧上、弧尾穿过字）：块的**下包络**（每列最低墨点）按相邻列落差切成平滑段，最长那段
/// ≥1.2 字号宽、墨中位厚 ≤0.15 字号、两端比最高处低 ≥0.15 字号（拱形）就是弧；剩下的墨得从弧顶以上 0.3 字号起笔（字立在弧上）。
/// 回弧的像素（段内每列最低墨点往上一个中位厚；底段整段不过 0.2 字号的列整段归弧）。不是这种块回空。TS `splitArcUnderGlyph` 同判据。
fn under_glyph_arc(ink: &Ink, k: &Comp, num_h: f64) -> Vec<(i64, i64)> {
    let b = &k.rect;
    if b.w < num_h * 1.5 || b.h <= num_h * 0.8 || b.h > num_h * 2.0 {
        return Vec::new();
    }
    let (bx, by, bw, bh) = (b.x as i64, b.y as i64, b.w as i64, b.h as i64);
    let own = |xx: i64, yy: i64| ink.owns(k, bx + xx, by + yy);
    let mut low = vec![-1i64; bw as usize];
    let mut thick = vec![0i64; bw as usize];
    for xx in 0..bw {
        let mut yy = bh - 1;
        while yy >= 0 && !own(xx, yy) {
            yy -= 1;
        }
        low[xx as usize] = yy;
        let mut t = 0;
        while yy - t >= 0 && own(xx, yy - t) {
            t += 1;
        }
        thick[xx as usize] = t;
    }
    let step = (num_h * 0.06).max(2.0);
    let (mut best, mut x0) = ((0i64, -1i64), -1i64);
    for xx in 0..=bw {
        let ok = xx < bw && low[xx as usize] >= 0 && (x0 < 0 || ((low[xx as usize] - low[xx as usize - 1]).abs() as f64) <= step);
        if ok && x0 < 0 {
            x0 = xx;
        } else if !ok && x0 >= 0 {
            if xx - 1 - x0 > best.1 - best.0 {
                best = (x0, xx - 1);
            }
            x0 = if xx < bw && low[xx as usize] >= 0 { xx } else { -1 };
        }
    }
    let run_w = best.1 - best.0 + 1;
    if run_w <= 0 {
        return Vec::new();
    }
    let in_run = |xx: i64| xx >= best.0 && xx <= best.1;
    let t0 = median(&(best.0..=best.1).map(|xx| thick[xx as usize] as f64).filter(|&t| t > 0.0).collect::<Vec<_>>(), 0.0);
    let top_y = (best.0..=best.1).map(|xx| low[xx as usize]).min().unwrap_or(0);
    let end_y = low[best.0 as usize].min(low[best.1 as usize]);
    if (run_w as f64) < num_h * 1.2 || t0 > num_h * 0.15 || ((end_y - top_y) as f64) < num_h * 0.15 {
        return Vec::new();
    }
    let cap = t0.ceil() as i64 + 1;
    let cap_max = (cap as f64).max(num_h * 0.2);
    let arc_px = |xx: i64, yy: i64| {
        in_run(xx) && yy <= low[xx as usize] && yy > low[xx as usize] - if (thick[xx as usize] as f64) <= cap_max { thick[xx as usize] } else { cap }
    };
    let (mut arc, mut arc_top, mut glyph_top) = (Vec::new(), i64::MAX, i64::MAX);
    let (mut glyph_n, mut glyph_beside) = (0usize, 0usize);
    for yy in 0..bh {
        for xx in 0..bw {
            if !own(xx, yy) {
                continue;
            }
            if arc_px(xx, yy) {
                arc.push((bx + xx, by + yy));
                arc_top = arc_top.min(yy);
            } else {
                glyph_top = glyph_top.min(yy);
                glyph_n += 1;
                if !in_run(xx) {
                    glyph_beside += 1;
                }
            }
        }
    }
    // 字得从弧顶以上起笔（字脚压在弧上，字身在上面）；弧从字的侧边起（「D7」的 7 接着弧头，青年诗歌 48）字身大半在弧段外，比弧顶高就行
    // 整块都在弧段里的就是一道高拱的弧（比上面弧门的字号上限高，青年诗歌 48 跨四拍的长弧）
    if glyph_n == 0 && !arc.is_empty() {
        return arc;
    }
    let beside = glyph_n > 0 && glyph_beside as f64 >= glyph_n as f64 * 0.6;
    if arc.is_empty() || glyph_top == i64::MAX || glyph_top as f64 > arc_top as f64 - if beside { 1.0 } else { num_h * 0.3 } {
        return Vec::new();
    }
    arc
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
fn read_line(ink: &Ink, claims: &Claims, ocr: &CachedOcr, slope: f64, y0: i64, y1: i64, xa: i64, xb: i64, doubts: Option<&mut LineRanks>) -> Vec<Ch> {
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

/// 一行字的逐字候选：把握不大的汉字的中心 x；各汉字的前几名候选（中心 x、候选、得分），参照歌词选字用（TS `rankAlts`）。
#[derive(Default)]
struct LineRanks {
    doubt_xs: Vec<f64>,
    chars: Vec<(f64, Vec<String>, Vec<f32>)>,
}

/// 参照歌词选字时看 OCR 前几名（同 TS `rankTextChars(…, 10)`）。
const RANK_K: usize = 10;

/// 同 [`read_line`]，各段分开回。`doubts` 给了：再取逐字前几名（同一条画面，走内容缓存），把握不大的汉字的中心 x 与各汉字的候选记进去。
fn read_segs(ink: &Ink, claims: &Claims, ocr: &CachedOcr, slope: f64, y0: i64, y1: i64, xa: i64, xb: i64, mut doubts: Option<&mut LineRanks>) -> Vec<Vec<Ch>> {
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
        // 要候选时贪心解码与前几名一次推理出来
        let (got, ranks) = if doubts.is_some() {
            let Ok((g, r)) = ocr.read_line_ranked(&strip, RANK_K) else { continue };
            (g, Some(r))
        } else {
            let Ok(g) = ocr.read_line(&strip) else { continue };
            (g, None)
        };
        let sw = strip.w as f64;
        let x_left = sa as f64 - pad as f64;
        if let Some(d) = doubts.as_deref_mut() {
            // 排名与贪心解码按同一套分段，逐个对上；对不上（个数不同）就不判
            if let Some(rk) = ranks {
                if rk.len() == got.len() {
                    for (c, r) in got.iter().zip(&rk) {
                        let mut it = c.ch.chars();
                        let (Some(ch), None) = (it.next(), it.next()) else { continue };
                        if !is_han(ch) || r.alts.is_empty() {
                            continue;
                        }
                        let cx = x_left + (c.x0 + c.x1) / 2.0 * sw;
                        let margin = r.scores.first().copied().unwrap_or(1.0) - r.scores.get(1).copied().unwrap_or(0.0);
                        if r.alts[0] != c.ch || margin < LYRIC_DOUBT_MARGIN {
                            d.doubt_xs.push(cx);
                        }
                        d.chars.push((cx, r.alts.clone(), r.scores.clone()));
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

/// 读好、对好音的一行歌词，等同行各段比过对位再写进音里。
struct Pending {
    syls: Vec<(usize, String, bool)>,
    /// 与 `syls` 对齐：音节里那个汉字的 OCR 候选、得分与字框
    alts: Vec<Option<(Vec<String>, Vec<f32>, Rect)>>,
    /// 逐音节的源框（识别模式按原位逐字叠加，同 TS 歌词单字的 `lyricRegions`）
    cells: Vec<TextRegion>,
    /// 英文词：(音下标, 字迹左缘, 右缘)，弧认完后按拼写拆（`split_spanning_words`）
    exts: Vec<(usize, f64, f64)>,
    label: Option<String>,
    region: TextRegion,
    ratio: Option<f64>,
    gap: f64,
}

const CN_NUM: &str = "一二三四五六七八九十";

/// 行首的边注：汉字段号（`一`、`二、`）与「副」「(副)」，印在首音左边。回 (段号, 去掉边注后的字)。
fn margin_label(chars: &[Ch], first_x: f64, h: f64) -> (Option<String>, &[Ch]) {
    // 首音左边带右括号的一小段汉字（「(尾声)」，左括号常读丢）是边注、不入词（青年诗歌 14）；「(副一)」那种走下面记标签
    if let Some(k) = chars.iter().take(6).position(|c| ")）".contains(c.ch)) {
        let body: Vec<&Ch> = chars[..k].iter().filter(|c| is_han(c.ch)).collect();
        if !body.is_empty() && body.len() <= 4 && !body.iter().any(|c| c.ch == '副' || CN_NUM.contains(c.ch)) && chars[..k].iter().all(|c| is_han(c.ch) || "(（ ".contains(c.ch)) && chars[k].cx() < first_x - h * 0.2 {
            return (None, &chars[k + 1..]);
        }
    }
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
    // 段号照谱面记：后面印着的顿号、点一并记（「一、」）
    let sep: String = chars.get(j).filter(|d| "、.．".contains(d.ch)).map(|d| if d.ch == '．' { '.' } else { d.ch }).into_iter().collect();
    while chars.get(j).is_some_and(|c| ")）、.．:： ".contains(c.ch)) {
        j += 1;
    }
    if !chars.get(j).is_some_and(|c| is_han(c.ch) || "“‘\"".contains(c.ch)) {
        return (None, chars);
    }
    // 带括号的副歌标签「(副一)」「(副)」「(副歌)」照原样记成行首标签（同 TS `SIDE_LABEL_RE`）；不带括号的「副」是边注、不记
    if c.ch == '副' {
        let close = chars[i + 1..j].iter().any(|d| ")）".contains(d.ch));
        // 左括号常读丢（「副二) 因你爱」，青年诗歌 16）：有右括号就算带括号的标签
        if close {
            let body: String = chars[i..j].iter().map(|d| d.ch).filter(|&ch| ch == '副' || ch == '歌' || CN_NUM.contains(ch) || ch.is_ascii_digit()).collect();
            return (Some(format!("({body})")), &chars[j..]);
        }
        return (None, &chars[j..]);
    }
    (Some(format!("{}{sep}", c.ch)), &chars[j..])
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
pub fn lyrics(ink: &Ink, rows: &[RowFrame], notes: &mut [RowNotes], labels: &mut [Vec<String>], ocr: &CachedOcr, regions: &mut Vec<TextRegion>, stanza_regions: &mut Vec<TextRegion>, footnotes: &mut Vec<String>) {
    let w = ink.w() as f64;
    let num_h0 = median(&rows.iter().map(|r| r.h()).collect::<Vec<_>>(), 0.0);
    let claims = Claims::new(ink, notes.iter().flat_map(|n| n.claimed.iter().copied())).tall_runs(ink, num_h0 * 2.2);
    let mut max_verses = 0usize;
    // 写下的各行词：(谱行, 段, 歌词区下标起止, 字数, 汉字数)
    let mut written: Vec<(usize, usize, usize, usize, usize, usize)> = Vec::new();
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
                // 横向只占一小截的（行末的「D.S. al Fine」、注记）也不占：歌词一行铺满大半行（世上所有的民族末行）
                let (mut lo, mut hi) = (i64::MAX, i64::MIN);
                for x in xa.max(0)..xb.min(ink.w() as i64) {
                    if (l.0..=l.1).any(|y| claims.free(ink, x, y + (row.band.slope * (x as f64 - w / 2.0)).round() as i64)) {
                        lo = lo.min(x);
                        hi = hi.max(x);
                    }
                }
                let wide = hi >= lo && (hi - lo) as f64 >= (xb - xa) as f64 * 0.25;
                full += (full > 0 || (((l.1 - l.0 + 1) as f64) >= h * 0.9 && wide)) as usize;
                keep = k + 1;
            }
            lines.truncate(keep);
            // 谱后的诗行另切一遍：独占一行的段号墨少，按字行的密度门进不来
            let from = lines.last().map_or(ya, |l| l.1 + 1);
            stanza_lines = cut_lines_at(ink, &claims, row.band.slope, from, yb, (0, ink.w() as i64), h * 0.25, (one > 0.0).then_some(one), LABEL_INK);
        }
        let note_ix: Vec<usize> = (0..notes[i].nums.len()).filter(|&k| notes[i].nums[k].digit != 0).collect();
        let note_xs: Vec<f64> = note_ix.iter().map(|&k| notes[i].nums[k].bbox.cx()).collect();
        let mut pend: Vec<Pending> = Vec::new();
        for (y0, y1) in lines {
            let mut ranks = LineRanks::default();
            let mut chars: Vec<Ch> = Vec::new();
            for mut seg in read_segs(ink, &claims, ocr, row.band.slope, y0, y1, xa, xb, Some(&mut ranks)) {
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
            // 和弦行夹着段落名（「E 【Chorus】 A D E」）也是：段落名、方括号注记先剔掉再看覆盖率
            let chordish = chords::is_annotation_line(&text);
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
            } else if let Some(l) = lr.label.as_mut() {
                // 数字段号后面的点读丢时一律补了点；回原图看数字与后一个字之间有没有一团墨，没有就照谱面不带点
                if l.ends_with('.') && !chars.iter().any(|c| c.ch == '.' || c.ch == '．') {
                    let k = chars.iter().position(|c| c.ch.is_ascii_digit());
                    if let Some(k) = k {
                        let d = &chars[k + l.len() - 2];
                        if let Some(nx) = chars.get(k + l.len() - 1) {
                            // 数字与后一个字的字心之间、行的下半截有没有一个点大小的独立小块（OCR 字位不准，量空白列会量进邻字）
                            let lh = (y1 - y0 + 1) as f64;
                            let ymid = (y0 + y1) as f64 / 2.0;
                            let mid = w / 2.0;
                            let dot = ink.comps().iter().any(|k| {
                                let cy = k.cy - row.band.slope * (k.cx - mid);
                                k.rect.w <= lh * 0.3 && k.rect.h <= lh * 0.3 && k.cx > d.cx() && k.cx < nx.cx() && cy >= ymid && cy <= y1 as f64 + 2.0
                            });
                            if !dot {
                                l.pop();
                            }
                        }
                    }
                }
            }
            if lr.syls.is_empty() {
                continue;
            }
            // 英文按词左缘对位（同 TS：音节起始 x 对音心；长词的字心常落到后一个音上，`dear` 罩着 `1̲ 1̲`）
            let latin = |s: &dolce_omr_text::lyrics::Syl| s.text.chars().any(|c| c.is_ascii_alphabetic()) && !s.text.chars().any(is_han);
            let at0 = align(&lr.syls.iter().map(|s| if latin(s) { s.x - s.w / 2.0 } else { s.x }).collect::<Vec<_>>(), &note_xs);
            // 一个英文词底下罩着几个没人认领的音（整词印在两三个音底下、没印连字符）：等弧认完再按拼写切（`split_spanning_words`），
            // 这里先记下词的字迹范围
            let placed: Vec<(dolce_omr_text::lyrics::Syl, usize)> = lr.syls.iter().cloned().zip(at0.iter().copied()).collect();
            let line_h = (y1 - y0 + 1) as f64;
            let at: Vec<usize> = placed.iter().map(|p| p.1).collect();
            lr.syls = placed.into_iter().map(|p| p.0).collect();
            // (音下标, 字, 把握不大)
            let syls: Vec<(usize, String, bool)> = lr
                .syls
                .iter()
                .zip(&at)
                .map(|(s, &k)| {
                    // 英文音节后面印着连字符（接下一个音节）的，字后带「-」（同 TS，写出端转 `\-`）
                    let hy = matches!(s.syllabic, dolce_omr_text::lyrics::Syllabic::Begin | dolce_omr_text::lyrics::Syllabic::Middle);
                    let text = if hy { format!("{}-", s.text) } else { s.text.clone() };
                    (note_ix[k], text, s.text.chars().any(is_han) && ranks.doubt_xs.iter().any(|&x| (x - s.x).abs() <= s.w / 2.0 + 0.5))
                })
                .collect();
            // 英文词的字迹范围（左缘、过末字中部的右缘），按音下标
            let exts: Vec<(usize, f64, f64)> = lr
                .syls
                .iter()
                .zip(&at)
                .filter(|(s, _)| s.text.chars().any(|c| c.is_ascii_alphabetic()) && !s.text.chars().any(is_han))
                .map(|(s, &k)| (note_ix[k], s.x - s.w / 2.0 - line_h * 0.3, s.x + s.w / 2.0 - line_h * 0.3))
                .collect();
            // 字落在音正下方（0.4 字号内）的比例：夹在谱行间的普通文字与同行各段词错开（见下）
            let han: Vec<&Ch> = chars.iter().filter(|c| is_han(c.ch)).collect();
            let ratio = (han.len() >= 4).then(|| han.iter().filter(|c| note_xs.iter().any(|&x| (x - c.cx()).abs() <= h * 0.4)).count() as f64 / han.len() as f64);
            let region = TextRegion { text, bbox: Rect::new(chars.first().map_or(0.0, |c| c.x0), y0 as f64, chars.last().map_or(0.0, |c| c.x1) - chars.first().map_or(0.0, |c| c.x0), (y1 - y0 + 1) as f64), chars: Vec::new() };
            // 各音节里汉字的候选（音节里只一个汉字的才挂；按字心就近对上逐字候选）
            let alts: Vec<Option<(Vec<String>, Vec<f32>, Rect)>> = lr
                .syls
                .iter()
                .map(|s| {
                    if han_count(&s.text) != 1 {
                        return None;
                    }
                    let (cx, a, sc) = ranks.chars.iter().filter(|c| (c.0 - s.x).abs() <= s.w / 2.0 + 1.0).min_by(|p, q| (p.0 - s.x).abs().total_cmp(&(q.0 - s.x).abs()))?;
                    let hw = s.w.min((y1 - y0 + 1) as f64) / 2.0;
                    Some((a.clone(), sc.clone(), Rect::new(cx - hw, y0 as f64, hw * 2.0, (y1 - y0 + 1) as f64)))
                })
                .collect();
            let cells: Vec<TextRegion> = lr
                .syls
                .iter()
                .filter(|s| !s.text.trim().is_empty())
                .map(|s| TextRegion { text: s.text.clone(), bbox: Rect::new(s.x - s.w / 2.0, y0 as f64, s.w.max(1.0), (y1 - y0 + 1) as f64), chars: Vec::new() })
                .collect();
            pend.push(Pending { syls, alts, cells, exts, label: lr.label, region, ratio, gap: (y0 - ya) as f64 });
        }
        // 与同谱行别的歌词行错开、字不落在音下的一行是夹在谱行间的普通文字（青年诗歌 16《神圣罗曼史》第 4 行词下
        // 「(副歌接下一页 注：…)」只有 0.42，同行四段词都是 1.00；同 TS `misaligned`）。只比同一谱行：四声部谱的词对的是另一声部的音，整行几段一起低
        let ratios: Vec<Option<f64>> = pend.iter().map(|p| p.ratio).collect();
        let misaligned = |k: usize| {
            let Some(a) = ratios[k].filter(|&a| a < 0.6) else { return false };
            let sib: Vec<f64> = ratios.iter().enumerate().filter(|&(j, v)| j != k && v.is_some_and(|v| v >= 0.8)).map(|(_, v)| v.unwrap()).collect();
            sib.len() >= 2 && median(&sib, 0.0) - a >= 0.35
        };
        let mut verse = 0usize;
        for (k, p) in pend.into_iter().enumerate() {
            if misaligned(k) {
                if std::env::var("OMR_JP_DEBUG").is_ok() {
                    eprintln!("  丢：与同行各段词错开 {}", p.region.text);
                }
                continue;
            }
            written.push((i, verse, regions.len(), regions.len() + p.cells.len(), p.syls.iter().map(|x| x.1.chars().count()).sum(), p.syls.iter().map(|x| han_count(&x.1)).sum()));
            for ((ni, t, doubt), alt) in p.syls.into_iter().zip(p.alts) {
                let n = &mut notes[i].nums[ni];
                if n.lyrics.len() <= verse {
                    n.lyrics.resize(verse + 1, String::new());
                }
                if let Some((alts, scores, bbox)) = alt {
                    n.lyric_alts.push(crate::result::LyricAlt { verse, idx: han_count(&n.lyrics[verse]), alts, scores, bbox });
                }
                n.lyrics[verse].push_str(&t);
                if doubt && !n.lyric_doubt.contains(&verse) {
                    n.lyric_doubt.push(verse);
                }
            }
            for (ni, x0, x1) in p.exts {
                notes[i].nums[ni].word_ext.push((verse, x0, x1));
            }
            if labels[i].len() <= verse {
                labels[i].resize(verse + 1, String::new());
            }
            labels[i][verse] = p.label.unwrap_or_default();
            if verse == 0 {
                first_gaps.push(p.gap);
            }
            regions.extend(p.cells);
            verse += 1;
        }
        max_verses = max_verses.max(verse);
    }
    drop_pseudo_verses(notes, labels, regions, &written);
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
    stanzas(ink, &claims, rows, notes, labels, ocr, &stanza_lines, stanza_regions, footnotes);
}

/// 剔伪段（同 TS）：谱行下方的噪声、记号（弧与「渐慢 rit.」凑成的一截，迦南 1775）被当成额外的一段词。真段有字的谱行横跨全曲：
/// 有字谱行数不到主段（有字谱行最多的那段）一半的，在它出现的那一行还得是完整一行——字数到主段同一谱行的六成——才留
/// （多段谱的第 2..N 段只印在主歌那几行）。主段是汉字词的只比汉字数（拉丁碎字凑不成一行中文词）。
/// 按视觉行序整体决定去留；剔掉的连歌词区一起去（认弧时按歌词区封顶）。
fn drop_pseudo_verses(notes: &mut [RowNotes], labels: &mut [Vec<String>], regions: &mut Vec<TextRegion>, written: &[(usize, usize, usize, usize, usize, usize)]) {
    use std::collections::{HashMap, HashSet};
    let mut rows_of: HashMap<usize, HashSet<usize>> = HashMap::new();
    for &(r, v, _, _, n, _) in written {
        if n > 0 {
            rows_of.entry(v).or_default().insert(r);
        }
    }
    let primary = rows_of.values().map(|s| s.len()).max().unwrap_or(0);
    let Some(pv) = rows_of.iter().max_by_key(|(v, s)| (s.len(), std::cmp::Reverse(**v))).map(|(v, _)| *v) else { return };
    let count = |r: usize, v: usize, han: bool| written.iter().filter(|w| w.0 == r && w.1 == v).map(|w| if han { w.5 } else { w.4 }).sum::<usize>();
    let mut real: HashSet<usize> = HashSet::new();
    for &(r, v, _, _, _, _) in written {
        if rows_of.get(&v).map_or(0, |s| s.len()) * 2 >= primary {
            real.insert(v);
            continue;
        }
        let han = count(r, pv, true) * 2 >= count(r, pv, false);
        let rf = count(r, pv, han);
        if rf > 0 && count(r, v, han) as f64 >= rf as f64 * 0.6 {
            real.insert(v);
        }
    }
    let mut gone: Vec<usize> = Vec::new();
    for &(r, v, ra, rb, _, _) in written {
        if real.contains(&v) {
            continue;
        }
        if std::env::var("OMR_JP_DEBUG").is_ok() {
            eprintln!("  丢伪段 行{r} 段{v}: {}", regions[ra..rb].iter().map(|c| c.text.as_str()).collect::<String>());
        }
        for n in notes[r].nums.iter_mut() {
            if let Some(t) = n.lyrics.get_mut(v) {
                t.clear();
            }
            n.lyric_doubt.retain(|&d| d != v);
            n.word_ext.retain(|e| e.0 != v);
            n.lyric_alts.retain(|a| a.verse != v);
        }
        if let Some(l) = labels[r].get_mut(v) {
            l.clear();
        }
        gone.extend(ra..rb);
    }
    // 各行末尾空下来的段截掉
    for (r, rn) in notes.iter_mut().enumerate() {
        let keep = rn.nums.iter().map(|n| n.lyrics.iter().rposition(|t| !t.is_empty()).map_or(0, |k| k + 1)).max().unwrap_or(0);
        for n in rn.nums.iter_mut() {
            n.lyrics.truncate(keep);
        }
        labels[r].truncate(keep.max(labels[r].iter().rposition(|l| !l.is_empty()).map_or(0, |k| k + 1)).min(labels[r].len()));
    }
    gone.sort_unstable();
    for ri in gone.into_iter().rev() {
        regions.remove(ri);
    }
}

/// 曲中斜杠式转拍号（同 TS `meter.slashInline`，选本 376 副歌行首的小号「4/4」）：斜笔（墨都落在从右上到左下的对角带里）左右各贴一个
/// 同高的块，右下方紧挨着正常大小的音（那一行的首音；页眉里「G调 6/8」离谱行两个字号开外，不算），同高处没有本行的音。
/// 两头按数字读成合法拍号（分子 1~16，分母 2 / 4 / 8 / 16）才收，锚到右边第一个音上。
pub fn slash_meters(ink: &Ink, rows: &[RowFrame], notes: &mut [RowNotes], ocr: &CachedOcr) {
    let num_h = median(&rows.iter().map(|r| r.h()).collect::<Vec<_>>(), 0.0);
    if num_h <= 0.0 {
        return;
    }
    let comps = ink.comps();
    let slash = |b: &Rect| {
        let (mut diag, mut off) = (0usize, 0usize);
        for y in b.y as i64..(b.y + b.h) as i64 {
            for x in b.x as i64..(b.x + b.w) as i64 {
                if !ink.at(x, y) {
                    continue;
                }
                let u = (x as f64 - b.x) / (b.w - 1.0).max(1.0);
                let v = (y as f64 - b.y) / (b.h - 1.0).max(1.0);
                if (u + v - 1.0).abs() <= 0.35 {
                    diag += 1;
                } else {
                    off += 1;
                }
            }
        }
        diag >= 8 && off as f64 <= diag as f64 * 0.15
    };
    let read = |r: &Rect| -> Option<u32> {
        let t = ocr.read_cells(&[crate::frame::digit_cell(ink, r)]).ok()?.remove(0);
        let ds: String = t.chars().filter(|c| c.is_ascii_digit()).collect();
        ds.parse().ok()
    };
    for sl in comps.iter().map(|k| k.rect) {
        if sl.h < num_h * 0.5 || sl.h > num_h * 0.95 || sl.w > sl.h * 0.8 || !slash(&sl) {
            continue;
        }
        let gap_of = |k: &Rect, dir: f64| if dir > 0.0 { k.x - sl.right() } else { sl.x - k.right() };
        let mate = |dir: f64| {
            comps
                .iter()
                .map(|k| k.rect)
                .filter(|k| *k != sl && (k.y - sl.y).abs() <= num_h * 0.15 && (k.h - sl.h).abs() <= num_h * 0.15 && gap_of(k, dir) >= -2.0 && gap_of(k, dir) <= num_h * 0.4)
                .min_by(|p, q| gap_of(p, dir).total_cmp(&gap_of(q, dir)))
        };
        let (Some(a), Some(b)) = (mate(-1.0), mate(1.0)) else { continue };
        let band = a.union(&sl).union(&b);
        // 右下方紧挨着本行首音、同高处没有本行的音
        let Some(ri) = (0..rows.len()).find(|&i| {
            let ns = &notes[i].nums;
            ns.iter().any(|n| n.bbox.h >= num_h * 0.85 && n.bbox.y >= band.bottom() - num_h * 0.3 && n.bbox.y <= band.bottom() + num_h * 0.5 && n.bbox.x >= band.x && n.bbox.x <= band.right() + num_h * 1.5)
                && !ns.iter().any(|n| (n.bbox.cy() - band.cy()).abs() <= num_h * 0.3 && (n.bbox.cx() - band.cx()).abs() <= num_h * 3.0)
        }) else {
            continue;
        };
        let (Some(up), Some(dn)) = (read(&a), read(&b)) else { continue };
        if !(1..=16).contains(&up) || ![2, 4, 8, 16].contains(&dn) {
            continue;
        }
        let rn = &mut notes[ri];
        if rn.meters.iter().any(|m| (m.x - band.cx()).abs() < num_h) {
            continue;
        }
        rn.meters.push(crate::result::RowMeter { x: band.cx(), beats: up, beat_type: dn, bbox: band });
        if let Some(n) = rn.nums.iter_mut().find(|n| n.bbox.x > band.cx()) {
            n.time_change = Some(TimeSig { beats: up, beat_type: dn });
        }
    }
}

/// 曲中叠排的转拍号（同 TS `meterCandidates`，诗歌本 714 混合拍小节线后的「3/4」）：一道与数字同宽量级的短横（分数线），
/// 正上、正下各紧贴一个字号相当的数字块，都不宽过分数线一半以上；分子、分母各自在同一高度左右 4.5 字号内都有别的数字的，
/// 是四声部谱夹在两声部之间的减时线，不算。读成合法拍号才收；分母常被当成一个带减时线的音，摘掉。锚到右边第一个音上。
pub fn stacked_meters(ink: &Ink, rows: &[RowFrame], notes: &mut [RowNotes], ocr: &CachedOcr) {
    let num_h = median(&rows.iter().map(|r| r.h()).collect::<Vec<_>>(), 0.0);
    if num_h <= 0.0 {
        return;
    }
    let comps = ink.comps();
    let digitish = |k: &Comp| k.rect.h >= num_h * 0.35 && k.rect.h <= num_h * 1.05 && k.rect.w >= num_h * 0.15 && k.rect.w <= num_h * 0.9;
    let read = |r: &Rect| -> Option<u32> {
        let t = ocr.read_cells(&[crate::frame::digit_cell(ink, r)]).ok()?.remove(0);
        let ds: String = t.chars().filter(|c| c.is_ascii_digit()).collect();
        ds.parse().ok()
    };
    for (ri, row) in rows.iter().enumerate() {
        let (top, bot) = (row.top_at(0.0).min(row.top_at(ink.w() as f64)), row.bottom_at(0.0).max(row.bottom_at(ink.w() as f64)));
        for l in comps.iter().filter(|l| l.rect.w >= num_h * 0.35 && l.rect.w <= num_h * 1.6 && l.rect.w >= l.rect.h * 2.5 && l.rect.cy() > top - num_h * 0.5 && l.rect.cy() < bot + num_h * 0.5) {
            let hb = &l.rect;
            let near = |k: &Comp| (k.rect.cx() - hb.cx()).abs() <= (num_h * 0.3).max(hb.w * 0.5);
            let pick = |up: bool| {
                comps
                    .iter()
                    .filter(|k| k.id != l.id && digitish(k) && near(k))
                    .filter(|k| {
                        let g = if up { hb.y - k.rect.bottom() } else { k.rect.y - hb.bottom() };
                        g >= -2.0 && g < num_h * 0.55
                    })
                    .min_by(|a, b| {
                        let g = |k: &&Comp| if up { hb.y - k.rect.bottom() } else { k.rect.y - hb.bottom() };
                        g(a).total_cmp(&g(b))
                    })
            };
            let (Some(up), Some(dn)) = (pick(true), pick(false)) else { continue };
            if up.rect.w > hb.w * 1.5 || dn.rect.w > hb.w * 1.5 || up.rect.h.min(dn.rect.h) < up.rect.h.max(dn.rect.h) * 0.8 {
                continue;
            }
            // 上下还叠着一条横线的是双减时线
            if comps.iter().any(|o| o.id != l.id && o.rect.w >= o.rect.h * 2.5 && (o.rect.cx() - hb.cx()).abs() <= hb.w * 0.5 && (o.rect.cy() - hb.cy()).abs() <= num_h * 0.3 && o.rect.cy() != hb.cy()) {
                continue;
            }
            let row_mate = |k: &Comp| comps.iter().any(|o| o.id != k.id && o.id != up.id && o.id != dn.id && digitish(o) && o.rect.h >= k.rect.h * 0.7 && (o.rect.cy() - k.rect.cy()).abs() <= num_h * 0.2 && (o.rect.cx() - k.rect.cx()).abs() <= num_h * 4.5);
            if row_mate(up) && row_mate(dn) {
                continue;
            }
            let (Some(b), Some(t)) = (read(&up.rect), read(&dn.rect)) else { continue };
            if !(1..=16).contains(&b) || ![2, 4, 8, 16].contains(&t) {
                continue;
            }
            let band = up.rect.union(&dn.rect).union(hb);
            let rn = &mut notes[ri];
            if rn.meters.iter().any(|m| (m.x - band.cx()).abs() < num_h) {
                continue;
            }
            if std::env::var("OMR_JP_DEBUG").is_ok() {
                eprintln!("行{ri} 转拍号 {b}/{t} @{:.0}", band.cx());
            }
            rn.nums.retain(|n| {
                let ov = (n.bbox.right().min(band.right()) - n.bbox.x.max(band.x)).max(0.0) * (n.bbox.bottom().min(band.bottom()) - n.bbox.y.max(band.y)).max(0.0);
                ov < n.bbox.w * n.bbox.h * 0.5
            });
            rn.meters.push(crate::result::RowMeter { x: band.cx(), beats: b, beat_type: t, bbox: band });
            if let Some(n) = rn.nums.iter_mut().find(|n| n.bbox.x > band.cx()) {
                n.time_change = Some(TimeSig { beats: b, beat_type: t });
            }
        }
        notes[ri].meters.sort_by(|a, b| a.x.total_cmp(&b.x));
    }
}

/// 一个英文词底下罩着几个没人认领的音（整词印在两三个音底下、没印连字符）：按拼写切成那么多段（同 TS `splitSpanningWords`）。
/// 罩住 = 音的中心落在词的字迹范围里；没人认领 = 本段这个音上没字、不是休止、不是弧 / 延音线的后续音（那是一字多音，本就该空着，
/// `every` 罩着 `2·⌒1̲`）。词心可能落在后一个音上（对音按就近）：往左把字迹范围里空着、不是后续音的也收进来。
/// 罩着的音比切得出的段多（`cono` 罩着 `6̲ 5̲ 6̲`）：从左取能切出的段数，剩下的是一字多音。弧要先认完，故在认弧之后做。
pub fn split_spanning_words(notes: &mut [RowNotes]) {
    for rn in notes.iter_mut() {
        let nums = &mut rn.nums;
        let mut cont = Vec::with_capacity(nums.len());
        let mut depth = 0i64;
        for n in nums.iter() {
            cont.push(depth > 0 || n.tie_stop);
            depth = (depth + n.slur_start as i64 - n.slur_stop as i64).max(0);
        }
        for k in (0..nums.len()).rev() {
            for (v, ex0, ex1) in nums[k].word_ext.clone() {
                let Some(text) = nums[k].lyrics.get(v).cloned() else { continue };
                let empty = |n: &crate::result::JpNum| n.lyrics.get(v).is_none_or(|t| t.is_empty());
                let free = |i: usize, nums: &[crate::result::JpNum]| empty(&nums[i]) && nums[i].digit != 0 && nums[i].digit != crate::result::RHYTHM_DIGIT;
                let mut first = k;
                while first > 0 && !cont[first] && free(first - 1, nums) && nums[first - 1].bbox.cx() >= ex0 {
                    first -= 1;
                }
                let mut span: Vec<usize> = (first..=k).collect();
                let mut i = k + 1;
                while i < nums.len() && nums[i].bbox.cx() < ex1 && free(i, nums) && !cont[i] {
                    span.push(i);
                    i += 1;
                }
                let (word, hy) = match text.strip_suffix('-') {
                    Some(w) => (w.to_string(), true),
                    None => (text.clone(), false),
                };
                let mut parts = None;
                while span.len() >= 2 {
                    parts = dolce_omr_text::ensyllable::split_english_word(&word, span.len());
                    if parts.is_some() {
                        break;
                    }
                    span.pop();
                }
                let Some(parts) = parts else { continue };
                let doubt = nums[k].lyric_doubt.contains(&v);
                nums[k].lyrics[v].clear();
                nums[k].lyric_doubt.retain(|&d| d != v);
                let last = parts.len() - 1;
                for (j, (t, &n)) in parts.into_iter().zip(&span).enumerate() {
                    let ly = &mut nums[n].lyrics;
                    if ly.len() <= v {
                        ly.resize(v + 1, String::new());
                    }
                    ly[v] = if j == last && hy { format!("{t}-") } else { t };
                    if doubt && !nums[n].lyric_doubt.contains(&v) {
                        nums[n].lyric_doubt.push(v);
                    }
                }
            }
        }
    }
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
fn stanzas(ink: &Ink, claims: &Claims, rows: &[RowFrame], notes: &mut [RowNotes], labels: &mut [Vec<String>], ocr: &CachedOcr, lines: &[(i64, i64)], regions: &mut Vec<TextRegion>, footnotes: &mut Vec<String>) {
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
    let mut prev_bot: Option<i64> = None;
    for (_, y0, seg, y1) in segs {
        let text: String = seg.iter().map(|c| c.ch).collect();
        let (xa, xb) = (seg.first().map_or(0.0, |c| c.x0), seg.last().map_or(0.0, |c| c.x1));
        let region = TextRegion { text: text.clone(), bbox: Rect::new(xa, y0 as f64, xb - xa, (y1 - y0 + 1) as f64), chars: Vec::new() };
        // 「注：…」起头的整段是页脚注：从这一行起，行距不过 1.5 倍行高的接续行并成一条；隔开的下一个「注」另起一条（同 TS stanzas.ts）
        if FOOTNOTE.is_match(text.trim_start()) || !footnotes.is_empty() {
            let t = text.trim().to_string();
            if FOOTNOTE.is_match(&t) {
                footnotes.push(t);
            } else if prev_bot.is_some_and(|b| (y0 - b) as f64 <= hh * 1.5) {
                if let Some(f) = footnotes.last_mut() {
                    f.push_str(&t);
                }
            } else {
                prev_bot = None;
                continue;
            }
            prev_bot = Some(y1);
            continue;
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
static KEY_BARE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*([b♭#♯]?)([A-G])([b♭#♯]?)(m?)\s*(?:[/／]\s*[b♭#♯]?[A-G][b♭#♯]?m?\s*)?(?:调|大调|\d{1,2}\s*[/／]\s*\d)").unwrap());
/// 整框只是个调名（可带「/调名」，变调夹谱的另一套调）：`Em/Bm`、`bE`。
static KEY_ALONE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*([b♭#♯]?)([A-G])([b♭#♯]?)(m?)\s*(?:[/／]\s*[b♭#♯]?[A-G][b♭#♯]?m?)?\s*$").unwrap());
/// 单字符路读出的音名组：可带前后升降号。
/// 和弦行里的跳转记号：只认写全的（`Fine`、D 后带点的 `D.C.` / `D. C`），宽松写法在和弦行多是连写和弦的误检（`G/D C` → `DC`）。
static CHORD_ROW_JUMP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"D\s*\.\s*[CS]\b\.?|Fine(?:[^a-z]|$)").unwrap());
/// 段落方框里的英文段落词。
static SECTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(intro|verse|chorus|pre-?chorus|bridge|coda|outro|ending|interlude|solo|refrain|tag)\d*").unwrap());
/// 中文段名「(副歌)」：带括号的、或整块只有这两个字的。
static CN_SECTION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[（(]\s*副\s*歌\s*[)）]|^[\s（(【\[]*副\s*歌[\s)）】\]：:]*$").unwrap());
/// 力度记号（相邻两个常读成一块：`mfdim.`）。
static DYN_TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)cresc|dim|ppp|pp|p|mp|mf|fff|ff|f").unwrap());
static KEY_GLYPHS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([b#♭♯]?)\s*([A-Ga-g])\s*([b#♭♯]?)$").unwrap());
static METER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d{1,2})\s*[/／]\s*(16|2|4|8)").unwrap());
/// 标题框开头的曲号：数字后面直接接汉字曲名。
static TITLE_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(\d{1,4})\s*[.．、]?\s*([一-鿿].*)$").unwrap());
/// 书眉：书名后接曲号（`青年诗歌—015`），或曲号在前、隔着破折号接书名（`060—青年诗歌`；不带破折号的「1942我们是一家人」是曲号加曲名）。曲号去掉前导零。
static BOOK_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(?:[一-鿿]{2,8}\s*[—\-－–_]*\s*0*(\d{1,4})|0*(\d{1,4})\s*[—\-－–_]+\s*[一-鿿]{2,8})\s*$").unwrap());
/// 页码紧贴书名、没有破折号的书眉（「018青年诗歌」）：只在框缩在页面一侧、位置在标题上部时才算（与「277从前所珍爱」这种曲号前缀同形）。
static RUNNING_HEAD_NODASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*\d{1,4}\s*[一-鿿]{2,8}\s*$").unwrap());
/// 署名末尾紧贴汉字的年份（可带「-」接卒年）。
static CREDIT_YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([一-鿿])(\d{4}(?:\s*[-–—]\s*\d{4})?)\s*$").unwrap());
/// 署名末尾的职能词组（「词曲」「作词、作曲」「译」）：1 是前面的名字。
static CREDIT_ROLE_TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(.*?[^\s：:])((?:[作編编]?[詞词曲])(?:\s*[、，,/／]?\s*(?:[作編编]?[詞词曲]))*)\s*$").unwrap());
static BRACKET_NOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\[［【].*[\]］】]$").unwrap());
static BRACKET_OPEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([\[［])\s*").unwrap());
static BRACKET_CLOSE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*([\]］])$").unwrap());
static NAME_YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([A-Za-z])\((\d{4})\)").unwrap());
/// 谱后的注：行首「注：」「(注:」（OCR 偶把冒号读成分号）。
static FOOTNOTE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[(（]?注\s*[:：;；]").unwrap());
/// 速度前的音符带附点：`♩.=`、`J.=`（rec 把四分音符读成 J、d）。
static DOTTED_BEAT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[♩♪Jjd]\s*[.．·•]\s*[=＝]").unwrap());
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
    // 各 det 框的逐字中心（页眉区按框找回来挂 `chars`）
    let mut line_chars: Vec<(Rect, Vec<crate::result::RegionChar>)> = Vec::new();
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
        // 调名紧跟拍号的（「Em4/4」「Em 3/4」）是调号拍号，不是和弦
        if top - (b.y + b.h) <= num_h * 3.0 && chords::is_annotation_line(&text) && !(KEY_BARE.is_match(&text) && METER.is_match(&text)) {
            continue;
        }
        if !text.trim().is_empty() {
            line_chars.push((Rect::new(b.x, b.y, b.w, b.h), chars.iter().filter(|c| c.ch != ' ').map(|c| crate::result::RegionChar { text: c.ch.to_string(), cx: c.cx() }).collect()));
            lines.push(WordLine { text, x: b.x, y: b.y, w: b.w, h: b.h });
        }
    }
    // det 把一行切成几框的（「祂來」|「過」、「泥土音乐《脚步》」|「（2007）」）：同高、同一横排、挨着的并回一行。
    // 两截汉字中间隔着一道 det 没框进来的破折号（「经历基督」——「作牧人」）的也并，补上「——」
    lines.sort_by(|a, b| a.x.total_cmp(&b.x));
    let mut joined: Vec<WordLine> = Vec::new();
    for l in lines {
        let mut dashed = false;
        let hit = joined.iter_mut().find(|j| {
            let ov = (j.y + j.h).min(l.y + l.h) - j.y.max(l.y);
            let hh = j.h.min(l.h);
            let gap = l.x - (j.x + j.w);
            let same_row = ov >= hh * 0.6 && (j.h - l.h).abs() <= hh * 0.3 && !NUMBER.is_match(&j.text) && !NUMBER.is_match(&l.text);
            // 切开的框是叠着或贴着的（隔开的是两行字：曲号与标题、署名与副标题）
            if same_row && gap <= hh * 0.1 && gap >= -hh {
                return true;
            }
            dashed = same_row && gap > hh * 0.3 && gap <= hh * 3.0 && j.text.chars().last().is_some_and(is_han) && l.text.chars().next().is_some_and(is_han) && dash_between(ink, j.x + j.w, l.x, j.y.max(l.y), (j.y + j.h).min(l.y + l.h));
            dashed
        });
        match hit {
            Some(j) => {
                let latin = j.text.chars().last().is_some_and(|c| c.is_ascii_alphanumeric()) && l.text.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
                j.text = format!("{}{}{}", j.text, if dashed { "——" } else if latin { " " } else { "" }, l.text);
                let (x1, y1) = ((j.x + j.w).max(l.x + l.w), (j.y + j.h).max(l.y + l.h));
                j.y = j.y.min(l.y);
                j.w = x1 - j.x;
                j.h = y1 - j.y;
            }
            None => joined.push(l),
        }
    }
    // det 把署名与紧跟着的调号框成一行（「作词：托普雷迪1=bB 3」）：在「1=」处切成两行，左段汉字、右段调号各归各的
    let mut lines: Vec<WordLine> = Vec::new();
    for l in joined {
        let cut = l.text.find("1=").or_else(|| l.text.find("1＝")).filter(|&k| k > 0 && l.text[..k].chars().any(is_han));
        match cut {
            Some(k) => {
                let n = l.text.chars().count() as f64;
                let nk = l.text[..k].chars().count() as f64;
                let xk = l.x + l.w * nk / n;
                lines.push(WordLine { text: l.text[..k].trim().to_string(), x: l.x, y: l.y, w: xk - l.x, h: l.h });
                lines.push(WordLine { text: l.text[k..].to_string(), x: xk, y: l.y, w: l.x + l.w - xk, h: l.h });
            }
            None => lines.push(l),
        }
    }
    extend_spaced_title(ink, ocr, num_h, &mut lines);
    // 曲号不比标题小多少（拍号的分子、速度数字小得多）
    // 调号框不算（竖排叠印的拍号、速度挤进调号框，把框撑到两排字高：迦南 1727 的 90 比曲号 46 高出一倍）
    let max_h = lines.iter().filter(|l| !KEY.is_match(&l.text)).map(|l| l.h).fold(0.0, f64::max);
    // 标题：不是书眉、曲号的行里最大的那行
    let pw = ink.w() as f64;
    let one_side = |l: &WordLine| l.x + l.w < pw / 2.0 || l.x > pw / 2.0;
    let plain = || lines.iter().filter(|l| !BOOK_NUMBER.is_match(&l.text) && !NUMBER.is_match(&l.text) && !(RUNNING_HEAD_NODASH.is_match(&l.text) && one_side(l)));
    let title_h = plain().map(|l| l.h).fold(0.0, f64::max);
    let title_y = plain().find(|l| l.h == title_h).map_or(0.0, |l| l.y);
    let mut rest: Vec<WordLine> = Vec::new();
    let mut number: Option<(String, f64, f64)> = None;
    let mut key_found = false;
    let mut meter_bands: Vec<(f64, f64)> = Vec::new();
    let key_boxes: Vec<WordLine> = lines.iter().filter(|k| KEY.is_match(&k.text)).cloned().collect();
    let mixed_word = lines.iter().any(|l| l.text.contains("混合拍"));
    for l in lines {
        // 书眉「青年诗歌—015」「青年诗歌073」「018青年诗歌」：书名带页码，不当标题、也不记曲号（是页码：13 首印在 18 页、53 首在 58 页；同 TS）
        if BOOK_NUMBER.is_match(&l.text) || (RUNNING_HEAD_NODASH.is_match(&l.text) && one_side(&l)) {
            // 书眉在页顶：整行在最大那行字（标题）顶上（署名「戴克斯曲1861」「合译1932」与标题同排或在下面）
            // 书眉框缩在页面一侧、中线在标题上部（det 把大号斜体页码的框撑到与标题一样高、两框交叠一截：青年诗歌 21「青年诗歌021」）
            let wf = ink.w() as f64;
            let side = l.x + l.w < wf / 2.0 || l.x > wf / 2.0;
            if l.y + l.h <= title_y || (side && l.y + l.h / 2.0 < title_y + title_h * 0.3) {
                continue;
            }
        }
        let mut used = false;
        // 单独一框的「混合拍」（拍号说明，诗歌本 714 印在几个拍号下面）不是署名
        if l.text.trim().trim_matches(|c| "()（）".contains(c)) == "混合拍" {
            score.meter_note = Some("混合拍".into());
            continue;
        }
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
            key_found = true;
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
                key_found = true;
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
                    meter_bands.push((l.y, l.y + l.h));
                    if l.text.contains("混合拍") {
                        score.meter_note = Some("混合拍".into());
                    }
                }
            }
        }
        // 速度与调号、「混合拍」挤在一框（迦南 1727「1=C 4 混合拍 ♩=75」，rec 在「=」后多读一道「-」）：取最后一个汉字之后那段、去掉「=」后的横
        let tail: String = l.text.rsplit(is_han).next().unwrap_or("").replace("=-", "=").replace("=—", "=");
        let metro = words::metronome(&l.text).or_else(|| if tail.len() < l.text.len() || tail.contains("=") { words::metronome(&tail) } else { None });
        if let Some((bpm, _)) = metro {
            score.tempo = Some(bpm);
            // 音符后带附点的（`♩.=60`，rec 读成「J.=60」）：拍单位是附点四分
            if DOTTED_BEAT.is_match(&l.text) {
                score.tempo_beat = Some(crate::result::BeatUnit { num: 3, den: 8 });
            }
            used = true;
        }
        // 紧贴调号框右边的纯数字框是叠排拍号（「1=G」后的 4/4 读成一个「4」，诗歌本 1），不是曲号
        let beside_key = key_boxes.iter().any(|k| {
            l.x - (k.x + k.w) <= num_h * 0.5 && l.x + l.w > k.x + k.w && (l.y + l.h).min(k.y + k.h) - l.y.max(k.y) >= l.h.min(k.h) * 0.5
        });
        // 只读出一位数、框高近两倍于宽的也是叠排拍号（赞美诗歌 936「4/4」读成「4」、43×89，比曲号框还高）
        let stacked = l.text.trim().chars().filter(|c| c.is_ascii_digit()).count() == 1 && l.h >= l.w * 1.8;
        if let Some(c) = NUMBER.captures(&l.text).filter(|_| !beside_key && !stacked) {
            if l.h >= num_h * 0.6 && l.h >= max_h * 0.5 && number.as_ref().is_none_or(|n| n.2 < l.h) {
                number = Some((c[1].trim_start_matches('0').to_string(), l.x + l.w / 2.0, l.h));
            }
            used = true;
        }
        if !used {
            rest.push(l);
        }
    }
    // 调名单独一框、拍号在同一排另一框（青年诗歌 79「Em/Bm」…「4/4」）：没读到调号时，与拍号同排、整框只是个调名（可带「/调名」）的认调号
    if !key_found {
        if let Some(k) = rest.iter().position(|l| KEY_ALONE.is_match(&l.text) && meter_bands.iter().any(|&(a, b)| (l.y + l.h).min(b) - l.y.max(a) >= l.h.min(b - a) * 0.5)) {
            let c = KEY_ALONE.captures(&rest[k].text).unwrap();
            let alt = |t: &str| match t {
                "b" | "♭" => -1,
                "#" | "♯" => 1,
                _ => 0,
            };
            let alter = alt(&c[1]) + alt(&c[3]);
            let letter = c[2].chars().next().unwrap();
            let minor = &c[4] == "m";
            score.fifths = fifths_of(letter, alter) - if minor { 3 } else { 0 };
            score.minor = minor;
            score.key = format!("{letter}{}{}", if alter < 0 { "b" } else if alter > 0 { "#" } else { "" }, if minor { "m" } else { "" });
            rest.remove(k);
        }
    }
    stacked_meter(ink, top, num_h, ocr, score);
    // 「混合拍」与调号、速度挤在一框（迦南 1727），拍号是竖排叠印另行读出的
    if mixed_word && score.meters.len() >= 2 && score.meter_note.is_none() {
        score.meter_note = Some("混合拍".into());
    }
    // 整行包在方括号里、带汉字的是谱面说明（`[共2张：A（原调）、G调]`），不是署名、标题
    rest.retain(|l| {
        let t = l.text.trim();
        let note = BRACKET_NOTE.is_match(t) && t.chars().any(is_han);
        if note {
            let n = BRACKET_OPEN.replace(t, "$1 ");
            let n = BRACKET_CLOSE.replace(&n, " $1").into_owned();
            score.header_regions.push(TextRegion { text: n.clone(), bbox: Rect::new(l.x, l.y, l.w, l.h), chars: Vec::new() });
            score.header_notes.push(n);
        }
        !note
    });
    let cs = credits(&rest, 0.0, w);
    let title = cs.iter().find(|c| c.kind == Some(CreditType::Title));
    if let Some(t) = title {
        score.title = Some(t.text.clone());
        // 曲号与曲名印在一个框里（「1771你曾向主许下」）：开头的数字是曲号。署名整理时已把行首数字剥掉，回原行找
        let raw = rest.iter().find(|l| l.text.trim_end().ends_with(t.text.trim()) && TITLE_NUMBER.is_match(&l.text)).map(|l| l.text.clone()).unwrap_or_else(|| t.text.clone());
        if let Some(c) = TITLE_NUMBER.captures(&raw) {
            // 标题框里带的曲号优先于比标题矮的单独数字框（传统诗歌选集 1「1圣哉!…」旁边署名下的年份「1861」）
            if number.as_ref().is_none_or(|n| n.2 < t.rect.3 * 0.8) {
                number = Some((c[1].to_string(), f64::NEG_INFINITY, t.rect.3));
            }
            score.title = Some(c[2].trim().to_string());
        }
        for c in &cs {
            // 引题：标题上方印一行汉字、以破折号引出标题（青年诗歌 77、125「新耶路撒冷——」，同 TS subtitle.leadIn），不与标题居中；
            // 破折号 det 没框进去，看框右边两个字宽里有没有一道横墨，有就补回「——」记副标题
            let (cx0, cy0, cw, ch) = c.rect;
            if !std::ptr::eq(c, t) && score.subtitle.is_none() && cy0 + ch <= t.rect.1 && c.text.trim().chars().all(is_han) && c.text.trim().chars().count() >= 2 && dash_between(ink, cx0 + cw, cx0 + cw + ch * 2.2, cy0, cy0 + ch) {
                let text = format!("{}——", c.text.trim());
                score.header_regions.push(TextRegion { text: text.clone(), bbox: Rect::new(cx0, cy0, cw, ch), chars: Vec::new() });
                score.subtitle = Some(text);
                continue;
            }
            match c.kind {
                Some(CreditType::Title) if !std::ptr::eq(c, t) && score.subtitle.is_none() => score.subtitle = Some(c.text.clone()),
                Some(CreditType::Subtitle) if score.subtitle.is_none() => score.subtitle = Some(c.text.clone()),
                // 第二行副标题：紧贴第一行下面（心距不过一个半行高）
                Some(CreditType::Subtitle) if score.subtitles_more.is_empty() && {
                    let prev = cs.iter().find(|p| p.kind == Some(CreditType::Subtitle) && Some(&p.text) == score.subtitle.as_ref());
                    prev.is_some_and(|p| {
                        let (pc, cc) = (p.rect.1 + p.rect.3 / 2.0, c.rect.1 + c.rect.3 / 2.0);
                        cc > pc && pc > t.rect.1 + t.rect.3 / 2.0 && cc - pc <= p.rect.3.max(c.rect.3) * 1.5
                    })
                } => score.subtitles_more.push(c.text.clone()),
                // 汉字表情、速度说明（「中速」「稍快」「中速潇酒地」）：没有职能字，不是署名（同 TS，不收）
                Some(CreditType::Composer) | Some(CreditType::Lyricist)
                    if c.text.chars().all(|ch| is_han(ch) || ch.is_whitespace()) && !c.text.chars().any(|ch| "词詞曲译譯编編作配撰".contains(ch)) && c.text.chars().any(|ch| "速快慢地".contains(ch)) => {}
                Some(CreditType::Composer) | Some(CreditType::Lyricist) => {
                    // 整块印在标题左边的署名记左上（同 TS：只比横向，左栏往下排到标题下面的几行也算，马槽歌、三一来临歌）
                    let left_of = c.rect.0 + c.rect.2 <= t.rect.0;
                    // 英文名与括号年份之间 CTC 不吐空格（`Brian Doerksen(2002) 词曲`）
                    let t = NAME_YEAR.replace(&c.text, "$1 ($2)").into_owned();
                    if left_of { score.credits_top_left.push(t) } else { score.credits.push(t) }
                }
                _ => {}
            }
            score.header_regions.push(TextRegion { text: c.text.clone(), bbox: Rect::new(c.rect.0, c.rect.1, c.rect.2, c.rect.3), chars: Vec::new() });
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
    // 页眉区挂逐字位置：区里的字数与落在区里的那几个 det 框的字数对得上才挂（识别模式逐字对位，同 TS `TextRegion.chars`）
    for r in score.header_regions.iter_mut() {
        let mut cs: Vec<crate::result::RegionChar> = line_chars
            .iter()
            .filter(|(b, _)| {
                let ov = (b.right().min(r.bbox.right()) - b.x.max(r.bbox.x)).max(0.0) * (b.bottom().min(r.bbox.bottom()) - b.y.max(r.bbox.y)).max(0.0);
                ov >= b.w * b.h * 0.6
            })
            .flat_map(|(_, c)| c.iter().filter(|c| c.cx >= r.bbox.x - 1.0 && c.cx <= r.bbox.right() + 1.0).cloned())
            .collect();
        cs.sort_by(|a, b| a.cx.total_cmp(&b.cx));
        if !cs.is_empty() && cs.len() == r.text.chars().filter(|c| !c.is_whitespace()).count() {
            for (c, t) in cs.iter_mut().zip(r.text.chars().filter(|c| !c.is_whitespace())) {
                c.text = t.to_string();
            }
            r.chars = cs;
        }
    }
    // 标题词间的空格（「爱 喜乐 生命」「温州的水 温州的山」）：rec 把整行读成连着的字，按逐字位置补——
    // 相邻两字中心距比全行中位大出四成的地方是词间空白
    let spaced = |t: &str, regions: &[TextRegion]| -> Option<String> {
        if t.contains(' ') || t.chars().count() < 4 || !t.chars().any(is_han) {
            return None;
        }
        let r = regions.iter().find(|r| r.chars.len() >= t.chars().count() && r.chars.iter().map(|c| c.text.as_str()).collect::<String>().ends_with(t))?;
        let cs = &r.chars[r.chars.len() - t.chars().count()..];
        let gaps: Vec<f64> = cs.windows(2).map(|p| p[1].cx - p[0].cx).collect();
        let m = median(&gaps, 0.0);
        if m <= 0.0 || !gaps.iter().any(|&g| g > m * 1.4) {
            return None;
        }
        let mut out = String::new();
        for (k, c) in cs.iter().enumerate() {
            if k > 0 && gaps[k - 1] > m * 1.4 {
                out.push(' ');
            }
            out.push_str(&c.text);
        }
        Some(out)
    };
    if let Some(t) = score.title.clone().filter(|t| t.chars().all(is_han)) {
        if let Some(v) = spaced(&t, &score.header_regions) {
            score.title = Some(v);
        }
    }
    // 署名末尾的年份与汉字之间补空格（「贾迪尼曲 1769」「柯克帕特里克曲 1838-1921」，同 GT 口径）；署名里人名之间的空白按字距切会误切，不切
    for c in score.credits.iter_mut().chain(score.credits_top_left.iter_mut()) {
        *c = CREDIT_YEAR.replace(c, "$1 $2").into_owned();
    }
    // 署名里的空当（同 TS spaceIfGap，回源图量墨列）：名字与职能词之间（「林婉容 词曲」有、沧海一声笑「黄 霑作词」没有）、
    // 全是汉字的署名里两个人名之间（「刘廷芳 杨荫浏合译」）。两字之间最长的空白列比本框字间空白中位宽出八成、又够 0.2 字高才补
    let regions = score.header_regions.clone();
    for c in score.credits.iter_mut().chain(score.credits_top_left.iter_mut()) {
        let compact: Vec<char> = c.chars().filter(|ch| !ch.is_whitespace()).collect();
        let cs: String = compact.iter().collect();
        let Some(r) = regions.iter().find(|r| r.chars.iter().map(|x| x.text.as_str()).collect::<String>() == cs) else { continue };
        let (y0, y1) = (r.bbox.y.round() as i64, r.bbox.bottom().round() as i64);
        let blank = |xa: f64, xb: f64| {
            let (mut best, mut run) = (0, 0);
            for x in xa.round() as i64..=xb.round() as i64 {
                if (y0..y1).any(|y| ink.at(x, y)) {
                    run = 0;
                } else {
                    run += 1;
                    best = best.max(run);
                }
            }
            best as f64
        };
        let han_pair = |k: usize| r.chars[k - 1].text.chars().all(is_han) && r.chars[k].text.chars().all(is_han);
        let all: Vec<(usize, f64)> = (1..r.chars.len()).map(|k| (k, blank(r.chars[k - 1].cx, r.chars[k].cx))).collect();
        let latin = c.chars().any(|ch| ch.is_ascii_alphabetic());
        // 汉字署名比汉字字间；带拉丁字母的比全行字间（字母间空白小）
        let gaps: Vec<(usize, f64)> = all.iter().copied().filter(|&(k, _)| latin || han_pair(k)).collect();
        if gaps.len() < 2 {
            continue;
        }
        // 比的是别处字间空白的中位（不含这一处）
        let wide = |k: usize| {
            let typical = median(&gaps.iter().filter(|g| g.0 != k).map(|g| g.1).collect::<Vec<_>>(), 0.0);
            gaps.iter().any(|&(j, g)| j == k && g >= (typical * 1.8).max(r.bbox.h * 0.2))
        };
        let role_at = CREDIT_ROLE_TAIL.captures(c).map(|m| m.get(1).unwrap().as_str().chars().filter(|ch| !ch.is_whitespace()).count());
        if c.chars().all(|ch| is_han(ch) || ch.is_ascii_digit() || ch.is_whitespace() || "-–—、，,·".contains(ch)) {
            // 全汉字署名：按空当重排
            let mut out = String::new();
            for (k, ch) in compact.iter().enumerate() {
                if k > 0 && wide(k) {
                    out.push(' ');
                }
                out.push(*ch);
            }
            *c = CREDIT_YEAR.replace(&out, "$1 $2").into_owned();
        } else if let Some(at) = role_at.filter(|&at| at > 0 && at < compact.len() && wide(at)) {
            // 带拉丁字母的只补职能词前那一处
            let name_len = c.char_indices().filter(|(_, ch)| !ch.is_whitespace()).nth(at).map_or(c.len(), |(i, _)| i);
            if !c[..name_len].ends_with(' ') {
                *c = format!("{} {}", c[..name_len].trim_end(), &c[name_len..]);
            }
        }
    }
    // det 连「1=」那一行都漏了（迦南 1775 只框出标题、赞美诗歌 946 只框出「bE」）：回连通块里按字形找
    if !key_found {
        let (x_max, y_min) = title.map_or((w / 2.0, 0.0), |t| (t.rect.0 + t.rect.2 / 2.0, t.rect.1));
        if let Some(f) = key_by_glyphs(ink, ocr, x_max, y_min, top - num_h * 0.1, num_h) {
            score.fifths = f;
            score.minor = false;
            score.key = key_name(f);
        }
    }
}

/// 拉开字距排的书法体标题，det 只框到其中几个字（青年诗歌 98「唯　一　的　愛」只框到「的愛」：「唯」整个漏、「一」只是一道扁横）。
/// 同 TS `extendSpacedTitle`：页上最大一号的纯汉字框，两侧同一排上不落在任何 det 框里的墨按横向交叠并成字列，从框边往外逐列收
/// （列中线在框的纵向范围里、上下不出框三成字高、不高过一点二字高，宽或高够四成字高，与当前边缘的空当不过四个字高）；
/// 收到了连同原框重新读，读出的汉字数正好是原来的加上新收的列数才换——读不齐宁可不动。
fn extend_spaced_title(ink: &Ink, ocr: &CachedOcr, num_h: f64, lines: &mut [WordLine]) {
    let all_han = |t: &str| !t.trim().is_empty() && t.trim().chars().all(is_han);
    let Some(ti) = (0..lines.len()).filter(|&i| all_han(&lines[i].text)).max_by(|&a, &b| lines[a].h.total_cmp(&lines[b].h)) else { return };
    let t = &lines[ti];
    let h = t.h;
    if h < num_h * 1.3 {
        return;
    }
    let b = Rect::new(t.x, t.y, t.w, t.h);
    let in_any = |k: &Comp| lines.iter().any(|l| k.cx >= l.x && k.cx <= l.x + l.w && k.rect.cy() >= l.y && k.rect.cy() <= l.y + l.h);
    let mut pool: Vec<Rect> = ink
        .comps()
        .iter()
        .filter(|k| !in_any(k) && k.rect.cy() >= b.y && k.rect.cy() <= b.bottom() && k.rect.y >= b.y - h * 0.3 && k.rect.bottom() <= b.bottom() + h * 0.3 && k.rect.h <= h * 1.2)
        .map(|k| k.rect)
        .collect();
    pool.sort_by(|p, q| p.x.total_cmp(&q.x));
    let mut cols: Vec<Rect> = Vec::new();
    for r in pool {
        match cols.last_mut() {
            Some(last) if r.x <= last.right() => *last = last.union(&r),
            _ => cols.push(r),
        }
    }
    let big: Vec<Rect> = cols.into_iter().filter(|r| (r.w >= h * 0.4 || r.h >= h * 0.4) && r.h <= h * 1.2).collect();
    let mut add: Vec<Rect> = Vec::new();
    let (mut lx, mut rx) = (b.x, b.right());
    for r in big.iter().filter(|r| r.right() <= b.x).rev() {
        if lx - r.right() > h * 4.0 {
            break;
        }
        add.push(*r);
        lx = r.x;
    }
    for r in big.iter().filter(|r| r.x >= b.right()) {
        if r.x - rx > h * 4.0 {
            break;
        }
        add.push(*r);
        rx = r.right();
    }
    if add.is_empty() {
        return;
    }
    let u = add.iter().fold(b, |a, r| a.union(r));
    let Ok(got) = ocr.read_line(&ink.strip(&u, 2)) else { return };
    let txt: String = got.into_iter().map(|c| c.ch).collect::<String>().trim().to_string();
    if !all_han(&txt) || txt.chars().count() != t.text.trim().chars().count() + add.len() {
        return;
    }
    lines[ti] = WordLine { text: txt, x: u.x, y: u.y, w: u.w, h: u.h };
}

/// 五度圈位置 → 大调调名（`Bb`、`F#`）。
fn key_name(f: i32) -> String {
    const NAMES: [&str; 15] = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
    NAMES[(f + 7).clamp(0, 14) as usize].to_string()
}

/// 调号的单字符读法（同 TS `keyByGlyphs` 锚点一）：页眉里首行谱以上、标题中线左边的字号大小的块中找「=」——两道上下对齐的扁横，
/// 左边紧挨一个读得出 1（或就是一根细竖）的块（`二` `三` 的横笔、`♩=95` 的 `=` 靠这条挡掉）；也有反着印的 `C=1`。
/// 音名组取 `=` 另一侧紧挨着的至多四块（衬线体 E 断成三块再加上标 ♭），碰到拍号的分数线或比字宽的空当就停。
fn key_by_glyphs(ink: &Ink, ocr: &CachedOcr, x_max: f64, y_min: f64, y_max: f64, num_h: f64) -> Option<i32> {
    let mut pool: Vec<&Rect> = ink
        .comps()
        .iter()
        .filter(|k| k.rect.cy() >= y_min && k.rect.cy() <= y_max && k.cx < x_max && k.rect.h <= num_h * 2.0 && k.rect.w <= num_h * 2.0)
        .map(|k| &k.rect)
        .collect();
    pool.sort_by(|a, b| a.x.total_cmp(&b.x));
    let is_bar = |r: &Rect| r.w >= r.h * 2.5 && r.h <= num_h * 0.25 && r.w >= num_h * 0.2 && r.w <= num_h * 1.6;
    let ov_x = |a: &Rect, b: &Rect| (a.right().min(b.right()) - a.x.max(b.x)).max(0.0) / a.w.min(b.w).max(1.0);
    let mut eqs: Vec<Rect> = Vec::new();
    for a in pool.iter().filter(|r| is_bar(r)) {
        for b in pool.iter().filter(|r| is_bar(r)) {
            let dy = b.cy() - a.cy();
            if dy > 0.0 && dy <= num_h * 0.5 && ov_x(a, b) >= 0.6 {
                eqs.push(a.union(b));
            }
        }
    }
    for eq in &eqs {
        for dir in [1.0f64, -1.0] {
            let gap_to = |k: &Rect| if dir > 0.0 { eq.x - k.right() } else { k.x - eq.right() };
            let one = pool
                .iter()
                .filter(|k| !is_bar(k) && gap_to(k) >= -1.0 && gap_to(k) <= num_h && k.h >= num_h * 0.4 && eq.cy() >= k.y && eq.cy() <= k.bottom() && k.w <= k.h * 0.75)
                .min_by(|a, b| gap_to(a).total_cmp(&gap_to(b)));
            let Some(one) = one else { continue };
            // 衬线体的「1」只是一根带脚的细竖，数字模型常读不成 1：细竖本身就够
            if one.w > one.h * 0.4 {
                let t = ocr.read_cells(&[crate::frame::digit_cell(ink, one)]).ok()?;
                if crate::frame::digit_of(&t[0]) != Some(1) {
                    continue;
                }
            }
            // 音名组：从 `=` 另一侧起紧挨着的块
            let edge0 = if dir > 0.0 { eq.right() } else { eq.x };
            let mut cands: Vec<&&Rect> = pool.iter().filter(|k| !is_bar(k) && (if dir > 0.0 { k.x >= edge0 - 2.0 } else { k.right() <= edge0 + 2.0 }) && k.y <= one.bottom() && k.bottom() >= one.y).collect();
            cands.sort_by(|a, b| if dir > 0.0 { a.x.total_cmp(&b.x) } else { b.x.total_cmp(&a.x) });
            let first_gap = num_h.max(one.h);
            let mut group: Vec<Rect> = Vec::new();
            let mut cur = edge0;
            let mut ok = true;
            for k in cands {
                if k.w >= k.h * 2.5 && k.h <= num_h * 0.25 {
                    break;
                }
                let gap = if dir > 0.0 { k.x - cur } else { cur - k.right() };
                let gh = group.iter().map(|g| g.h).fold(0.0, f64::max);
                if gap > if group.is_empty() { first_gap } else { (gh * 0.6).max(4.0) } {
                    break;
                }
                group.push(**k);
                cur = if dir > 0.0 { cur.max(k.right()) } else { cur.min(k.x) };
                if group.len() > 4 {
                    ok = false;
                    break;
                }
            }
            if !ok || group.is_empty() {
                continue;
            }
            if let Some(f) = read_key_group(ink, ocr, &group) {
                return Some(f);
            }
        }
    }
    None
}

/// 读调号的音名组（同 TS `readKeyGroup`）：底边比其余块高出两成字高、竖长、形状判得出 ♭ / ♯ 的是上标升降号，其余并成一条送读，
/// 读出一个音名（可带升降号）才算。上标号形状看反的（出了五度圈）翻过来。
fn read_key_group(ink: &Ink, ocr: &CachedOcr, group: &[Rect]) -> Option<i32> {
    let lowest = group.iter().map(|g| g.bottom()).fold(f64::MIN, f64::max);
    let mut acc = 0i32;
    let mut letters: Vec<Rect> = group.to_vec();
    for (i, g) in group.iter().enumerate() {
        let lh = group.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, o)| o.h).fold(0.0, f64::max);
        if lh <= 0.0 || lowest - g.bottom() < lh * 0.2 || g.h < g.w {
            continue;
        }
        match crate::marks::accidental_of(ink, g) {
            Some("flat") => acc = -1,
            Some("sharp") => acc = 1,
            _ => continue,
        }
        letters.remove(i);
        break;
    }
    let read = |ks: &[Rect]| -> Option<(i32, char)> {
        let r = ks.iter().skip(1).fold(ks[0], |a, b| a.union(b));
        let t: String = ocr.read_line(&ink.strip(&r, 2)).ok()?.into_iter().map(|c| c.ch).collect();
        let c = KEY_GLYPHS.captures(t.trim())?;
        let a = |s: &str| match s {
            "b" | "♭" => -1,
            "#" | "♯" => 1,
            _ => 0,
        };
        let letter = c[2].chars().next()?;
        // 小写音名多半是降号本身读成的 b
        if letter.is_ascii_lowercase() {
            return None;
        }
        Some((a(&c[1]) + a(&c[3]), letter))
    };
    let (mut alt, mut letter) = match read(&letters) {
        Some(v) => v,
        None if acc != 0 => {
            acc = 0;
            read(group)?
        }
        None => return None,
    };
    if acc != 0 {
        alt = acc;
    }
    let mut f = fifths_of(letter, alt);
    if acc != 0 && !(-7..=7).contains(&f) {
        f = fifths_of(letter, -acc);
    }
    letter = letter.to_ascii_uppercase();
    let _ = letter;
    (-7..=7).contains(&f).then_some(f)
}

/// 两框之间（横向 `x0..x1`、纵向 `y0..y1`）只有一道破折号：中间那一截里有一行墨横贯过半个空当，空当里别的墨不多。
fn dash_between(ink: &Ink, x0: f64, x1: f64, y0: f64, y1: f64) -> bool {
    let (xa, xb) = (x0.ceil() as i64 + 1, x1.floor() as i64 - 1);
    let (ya, yb) = (y0.round() as i64, y1.round() as i64);
    if xb - xa < 4 || yb - ya < 4 {
        return false;
    }
    let hh = (yb - ya) as f64;
    let mut best = 0usize;
    let mut best_y = 0i64;
    for y in (y0 + hh * 0.3).round() as i64..=(y0 + hh * 0.75).round() as i64 {
        let n = (xa..=xb).filter(|&x| ink.at(x, y)).count();
        if n > best {
            best = n;
            best_y = y;
        }
    }
    if (best as f64) < (xb - xa + 1) as f64 * 0.5 {
        return false;
    }
    // 横墨上下 0.15 行高以外基本是空的（不是一个字）
    let far = (ya..=yb).filter(|&y| (y - best_y).abs() as f64 > hh * 0.15).map(|y| (xa..=xb).filter(|&x| ink.at(x, y)).count()).sum::<usize>();
    (far as f64) <= best as f64 * 0.3
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
    // 上方带从上一行最末一行歌词的底起（有的本子和弦行离谱行四五个字号，青年诗歌 5）；首行上面是页眉，只看近处
    let reach = if y_min > 0.0 { h * 6.0 } else { h * 2.8 };
    let ya = y_min.max(top - reach).max(0.0) as i64;
    let yb = top.floor() as i64 - 1;
    if rn.nums.is_empty() {
        return;
    }
    // 贯穿几行的竖墨（扫描件纸边、连谱号）不算，否则上方带连成一截切不开
    // 弧（扁宽、墨稀，粘连的「Am」墨实）与高音点、附点（小圆块）也不算：和弦字常与下面的弧、点上下挨着连成一截，取条就把弧切进字里读乱
    let marks = ink.comps().iter().filter(|k| {
        let r = &k.rect;
        // 伸进音符带半个字号以上的窄块是小节线（顶上粘着行末半弧，「主祢真伟大」读成 T、整行和弦丢）：和弦字不往下伸
        r.bottom() > ya as f64 && r.y < yb as f64 && ((r.bottom() > top + h * 0.5 && r.w <= h * 1.5) || (r.w >= h * 0.8 && r.h <= r.w * 0.5 && r.h <= h * 0.8 && k.fill() < 0.3) || (r.w <= h * 0.3 && r.h <= h * 0.3))
    });
    // segno 的墨也不读（`·S·D` 读成 `S·D`、和弦 D 跟着丢）
    let marks: Vec<&Comp> = marks.chain(ink.comps().iter().filter(|k| rn.segno_ink.contains(&k.id))).collect();
    let mut claims = Claims::comps(ink, marks.iter().copied()).tall_runs(ink, h * 2.2);
    // 弧顶粘着上方和弦字的块（青年诗歌 91 `F(C)⌒Dm(Am)` 弧尾连着 D，整块 164×44 过不了上面的弧门，D 读成 R、整行和弦全丢）：只扣弧那几像素
    for k in ink.comps().iter().filter(|k| k.rect.bottom() > ya as f64 && k.rect.y < yb as f64 && !marks.iter().any(|m| m.id == k.id)) {
        for (x, y) in under_glyph_arc(ink, k, h) {
            claims.mask[y as usize * claims.w + x as usize] = 1;
        }
    }
    let mut cands: Vec<ChordCand> = Vec::new();
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
        let mut text: String = cs.into_iter().collect();
        // 段落词与力度：和弦带也是上一行歌词带的下半截，段落方框（`Chorus`、「(副歌)」）、整块的力度常印在这里（首行上方带除外：
        // 那里收的多是页眉与音符上方的碎块，读出的噪声足以凑成段落词，同 TS）
        if y_min > 0.0 {
            let x_of = |i: usize| chars.get(i).map_or(0.0, |c| c.x0);
            let cn = CN_SECTION.find(&text).map(|m| (m.start(), m.end(), "(副歌)".to_string()));
            let hit = cn.or_else(|| {
                SECTION.find(&text).map(|m| {
                    let before = text[..m.start()].chars().last().unwrap_or(' ');
                    let after = text[m.end()..].chars().next().unwrap_or(' ');
                    let body = if m.as_str().chars().any(|c| c.is_ascii_uppercase()) {
                        m.as_str().to_string()
                    } else {
                        let mut cs = m.as_str().chars();
                        cs.next().map(|c| c.to_ascii_uppercase()).into_iter().chain(cs).collect()
                    };
                    let word = if "【[［".contains(before) && "】]］".contains(after) { format!("{before}{body}{after}") } else { body };
                    (m.start(), m.end(), word)
                })
            });
            if let Some((a, b, word)) = hit {
                let x = x_of(text[..a].chars().count());
                place_section(rn, x, word);
                text = format!("{}{}{}", &text[..a], " ".repeat(text[a..b].chars().count()), &text[b..]);
            }
            let skip = |c: char| c.is_whitespace() || ".,·•'`".contains(c);
            let kept: Vec<(usize, char)> = text.chars().enumerate().filter(|&(_, c)| !skip(c)).collect();
            let t: String = kept.iter().map(|&(_, c)| c).collect();
            let toks: Vec<regex::Match> = DYN_TOKEN.find_iter(&t).collect();
            let ink_w = chars.iter().map(|c| c.x1 - c.x0).sum::<f64>();
            if !t.is_empty() && !toks.is_empty() && toks.iter().map(|m| m.as_str().len()).sum::<usize>() == t.len() && ink_w <= t.len() as f64 * (y1 - y0 + 1) as f64 * 1.6 {
                for m in toks {
                    let x = x_of(kept[t[..m.start()].chars().count()].0);
                    let name = m.as_str().to_lowercase();
                    let name = if name.starts_with("cresc") || name.starts_with("dim") { name + "." } else { name };
                    let best = (0..rn.nums.len()).min_by(|&a, &b| (rn.nums[a].bbox.cx() - x).abs().total_cmp(&(rn.nums[b].bbox.cx() - x).abs())).unwrap();
                    rn.nums[best].dynamics.push(name);
                }
                continue;
            }
        }
        // 有的本子把 Fine / D.C. 就印在和弦行里（青年诗歌 2、48）：写全的 `Fine`、带点的 `D.C.` 和弦名凑不出来，照收成跳转记号再从行里抹掉
        if let Some(m) = CHORD_ROW_JUMP.find(&text) {
            let word = if m.as_str().starts_with('F') { "Fine" } else if m.as_str().contains('S') { "D.S." } else { "D.C." };
            let x = chars.get(text[..m.start()].chars().count()).map_or(0.0, |c| c.x0);
            let nums = &mut rn.nums;
            let mut bi = nums.len() - 1;
            while bi > 0 && nums[bi].bbox.cx() > x {
                bi -= 1;
            }
            if !nums[bi].jump_marks.iter().any(|w| w == word) {
                nums[bi].jump_marks.push(word.to_string());
            }
            let n = m.as_str().chars().count();
            text = format!("{}{}{}", &text[..m.start()], " ".repeat(n), &text[m.end()..]);
        }
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
        // 和弦行尾印着方框「副歌」这类一小段汉字（诗歌本 1，与「E7」挨着读成「E7副歌」）：共四字以内就把汉字抹掉再判，别让整行和弦丢掉
        let han_n = no_paren.chars().filter(|&c| is_han(c)).count();
        let no_paren: String = if han_n <= 4 { no_paren.chars().map(|c| if is_han(c) { ' ' } else { c }).collect() } else { no_paren };
        let clean = chords::blank_non_chord(&no_paren);
        let (cov, cnt) = chords::coverage(&clean);
        if !chords::is_chord_coverage(cov, cnt) || no_paren.chars().any(is_han) {
            continue;
        }
        let x_at = |i: usize| chars.get(i).map_or(0.0, |c| c.x0);
        for t in chords::split_tokens(&clean, Some(&x_at)) {
            let x = x_at(t.index);
            let x1 = chars.get(t.index + t.tok.chars().count() - 1).map_or(x, |c| c.x1);
            cands.push(ChordCand { tok: chords::normalize(&t.tok), x, bbox: Rect::new(x, y0 as f64, x1 - x, (y1 - y0 + 1) as f64) });
        }
    }
    place_chords(rn, cands, regions);
}

/// 段落词落位（同 TS）：标记框略偏左于段首音，按 x 找起点音再退回本小节首音；退到休止就停（弱起进段从休止后那个音起）。
fn place_section(rn: &mut RowNotes, x: f64, word: String) {
    let nums = &mut rn.nums;
    let num_h = median(&nums.iter().map(|n| n.bbox.h).collect::<Vec<_>>(), 1.0);
    let mut bi = nums.iter().position(|n| n.bbox.cx() >= x - num_h * 0.5).unwrap_or(0);
    let bar_x = rn.barline_xs.iter().copied().filter(|&b| b < nums[bi].bbox.cx()).fold(f64::NEG_INFINITY, f64::max);
    while bi > 0 && nums[bi - 1].bbox.cx() > bar_x && nums[bi - 1].digit != 0 {
        bi -= 1;
    }
    nums[bi].section_mark = Some(word);
}

/// 一个待落位的和弦：记号、左缘 x、源框。
struct ChordCand {
    tok: String,
    x: f64,
    bbox: Rect,
}

/// 印在增时线上方的和弦按增时线的源图位置定拍：横块与增时线数对得上、本音是四分音才用（一条线一拍，第 k 条在 (1+k)/(1+augment) 处）。
/// 左缘到横块右四分之一以内才算；再往右是下一个音的和弦往左探出来。
fn dash_beat(n: &crate::result::JpNum, x: f64) -> Option<f64> {
    let rs = &n.augment_rects;
    if rs.is_empty() || rs.len() != n.augment as usize || n.div > 0 || n.dot > 0 || x <= n.bbox.right() {
        return None;
    }
    rs.iter().enumerate().rev().find(|(_, r)| x >= r.x - r.w * 0.5 && x <= r.x + r.w * 0.75).map(|(k, _)| (1 + k) as f64 / (1 + n.augment) as f64)
}

/// 和弦落到音上（TS `chordline.ts::placeChords` 同判据）。比较基准取**左缘**：和弦的左缘习惯对齐所辖音的左缘。
/// 夹在两音之间的：明显贴右邻（0.65 以后）归右邻；0.35 以后、中间隔着小节线、左缘已到线前 0.3 字号以内的是下一小节的强拍和弦
/// （下一小节首音另有自己的和弦时不动）；其余挂左音 + 拍内偏移。同一音已有和弦：落在本音时值之内的记拍位（长音里换和弦），
/// 长音上方挤着的依次挂到增时线上，再不然顺延给右邻空位（限一格）；同名的不重挂。
fn place_chords(rn: &mut RowNotes, mut cands: Vec<ChordCand>, regions: &mut Vec<TextRegion>) {
    let nums = &mut rn.nums;
    if nums.is_empty() {
        return;
    }
    let lefts: Vec<f64> = nums.iter().map(|n| n.bbox.x).collect();
    cands.sort_by(|a, b| a.x.total_cmp(&b.x));
    let mut extra_y: std::collections::HashMap<usize, Vec<f64>> = std::collections::HashMap::new();
    let mut placed_x: std::collections::HashMap<usize, f64> = std::collections::HashMap::new();
    for ci in 0..cands.len() {
        let c = &cands[ci];
        let x = c.x;
        // 整个落在首音左边半个字号以外的不是和弦（行首竖排「（副歌）」的括号读成 C，8085）
        if c.bbox.right() < nums[0].bbox.x - nums[0].bbox.h * 0.5 {
            continue;
        }
        let mut i = 0;
        while i + 1 < lefts.len() && lefts[i + 1] <= x {
            i += 1;
        }
        let mut frac = 0.0;
        if let Some(d) = dash_beat(&nums[i], x) {
            frac = d;
        } else if i + 1 < lefts.len() && x > lefts[i] {
            let gap = lefts[i + 1] - lefts[i];
            if gap > 1.0 {
                let t = (x - lefts[i]) / gap;
                let h = nums[i].bbox.h;
                let bar = rn.barline_xs.iter().copied().find(|&bx| bx > nums[i].bbox.right() && bx < lefts[i + 1]);
                let nx = cands.get(ci + 1).map_or(f64::INFINITY, |c| c.x);
                let next_own = if i + 2 < lefts.len() { nx < lefts[i + 2] - (lefts[i + 2] - lefts[i + 1]) * 0.35 } else { nx < f64::INFINITY };
                if t >= 0.65 || (t >= 0.35 && bar.is_some_and(|b| x >= b - h * 0.3) && !next_own) {
                    i += 1;
                } else if t >= 0.35 {
                    frac = t;
                }
            }
        }
        let n = &nums[i];
        let prev_x = placed_x.get(&i).copied();
        if n.chord.as_deref() == Some(c.tok.as_str()) && !(prev_x.is_some_and(|p| x - p > n.bbox.h) && n.augment > 0) {
            continue;
        }
        if frac > 0.0 && n.chord.is_some() {
            let ys = extra_y.entry(i).or_default();
            let n = &mut nums[i];
            if let Some(k) = n.extra_chords.iter().position(|e| (e.offset - frac).abs() < 0.1) {
                // 同一拍位撞车 = 两套并行编配，留贴着谱行的下排
                if c.bbox.y > ys[k] {
                    n.extra_chords[k] = crate::result::ExtraChord { tok: c.tok.clone(), offset: frac };
                    ys[k] = c.bbox.y;
                    regions.push(TextRegion { text: c.tok.clone(), bbox: c.bbox, chars: Vec::new() });
                }
            } else if !n.extra_chords.iter().any(|e| e.tok == c.tok) {
                n.extra_chords.push(crate::result::ExtraChord { tok: c.tok.clone(), offset: frac });
                ys.push(c.bbox.y);
                regions.push(TextRegion { text: c.tok.clone(), bbox: c.bbox, chars: Vec::new() });
            }
            continue;
        }
        let n0 = &nums[i];
        if n0.chord.is_some() && n0.augment > 0 && n0.div == 0 && n0.dot == 0 && x > n0.bbox.x && (i + 1 >= nums.len() || x < lefts[i + 1]) {
            let aug = n0.augment;
            let n0 = &mut nums[i];
            if (n0.extra_chords.len() as u32) < aug {
                let offset = (1 + n0.extra_chords.len()) as f64 / (1 + aug) as f64;
                n0.extra_chords.push(crate::result::ExtraChord { tok: c.tok.clone(), offset });
                regions.push(TextRegion { text: c.tok.clone(), bbox: c.bbox, chars: Vec::new() });
            }
            continue;
        }
        if nums[i].chord.is_some() && i + 1 < nums.len() && nums[i + 1].chord.is_none() {
            i += 1;
            frac = 0.0;
        }
        if nums[i].chord.is_some() {
            continue;
        }
        nums[i].chord = Some(c.tok.clone());
        placed_x.insert(i, x);
        if frac > 0.0 {
            nums[i].chord_offset = Some(frac);
        }
        regions.push(TextRegion { text: c.tok.clone(), bbox: c.bbox, chars: Vec::new() });
    }
}
