//! JM2 / JM4 文字：谱行之间的歌词行（切行、分段取条送 rec、对到音上）、页眉（标题、署名、曲号、调号、拍号、速度）。
//!
//! 行按像素的纵向投影切（顺着行带的斜率投影），已归了音符的墨（减时线、低音点）不算字。
//! 字的分类、切音节、对音、页眉分类用 `omr-text`（与五线谱路线同一份）。
use crate::frame::{digit_cell, RowFrame};
use crate::notes::RowNotes;
use crate::prep::Ink;
use crate::result::{RecognizedScore, TextRegion};
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

/// 切出的一行字：纵向范围（页内坐标，行带斜率已折回行左端）与读出的字。
#[derive(Clone, Debug)]
pub struct TextLine {
    pub y0: i64,
    pub y1: i64,
    pub chars: Vec<Ch>,
}

impl TextLine {
    pub fn text(&self) -> String {
        self.chars.iter().map(|c| c.ch).collect()
    }
}

/// 页面大小的占用图：已归了音符的墨。
pub struct Claims {
    w: usize,
    mask: Vec<u8>,
}

impl Claims {
    pub fn new(ink: &Ink, rects: impl Iterator<Item = Rect>) -> Claims {
        let (w, h) = (ink.bin.w, ink.bin.h);
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
    fn free(&self, ink: &Ink, x: i64, y: i64) -> bool {
        ink.at(x, y) && self.mask[y as usize * self.w + x as usize] == 0
    }
}

/// 一条带 `[ya, yb)` 里的字行（纵向范围）。`slope`：行带斜率，投影时折掉。
/// 一截墨行不矮于 `min_h`、墨够密才算字行；几行挤成一截的在投影的谷里切开。
/// `one`：本页一行字的高（没给就不切挤在一起的行，回的是原始的各截——第一遍估行高用）。
fn cut_lines(ink: &Ink, claims: &Claims, slope: f64, ya: i64, yb: i64, min_h: f64, one: Option<f64>) -> Vec<(i64, i64)> {
    let w = ink.bin.w as i64;
    if yb <= ya {
        return Vec::new();
    }
    let n = (yb - ya) as usize;
    let mut proj = vec![0u32; n];
    for y in ya.max(0)..yb.min(ink.bin.h as i64) {
        for x in 0..w {
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
    // 密度：一行字的墨至少占「行高 × 页宽」的 0.6%（弧、点凑的一截到不了）
    let dense = |a: usize, b: usize| proj[a..=b].iter().sum::<u32>() as f64 >= (b - a + 1) as f64 * w as f64 * 0.006;
    let Some(one) = one else {
        return runs.into_iter().filter(|&(a, b)| (b - a + 1) as f64 >= min_h && dense(a, b)).map(|(a, b)| (ya + a as i64, ya + b as i64)).collect();
    };
    let mut out = Vec::new();
    for (a, b) in runs {
        let hh = (b - a + 1) as f64;
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
fn read_line(ink: &Ink, claims: &Claims, ocr: &CachedOcr, slope: f64, y0: i64, y1: i64, xa: i64, xb: i64) -> Vec<Ch> {
    let mut out: Vec<Ch> = Vec::new();
    for seg in read_segs(ink, claims, ocr, slope, y0, y1, xa, xb) {
        if let Some(l) = out.last() {
            let x = l.x1;
            out.push(Ch { ch: ' ', x0: x, x1: x });
        }
        out.extend(seg);
    }
    out
}

/// 同 [`read_line`]，各段分开回。
fn read_segs(ink: &Ink, claims: &Claims, ocr: &CachedOcr, slope: f64, y0: i64, y1: i64, xa: i64, xb: i64) -> Vec<Vec<Ch>> {
    let w = ink.bin.w as i64;
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

/// 各谱行下面的歌词：切行、读字、对音，写进各音的 `lyrics` 与行的段号。回各行歌词带的行（供叠加与排查）。
pub fn lyrics(ink: &Ink, rows: &[RowFrame], notes: &mut [RowNotes], labels: &mut [Vec<String>], ocr: &CachedOcr, regions: &mut Vec<TextRegion>) {
    let claims = Claims::new(ink, notes.iter().flat_map(|n| n.claimed.iter().copied()));
    let w = ink.bin.w as f64;
    let mut max_verses = 0usize;
    let mut stanza_lines: Vec<(i64, i64)> = Vec::new();
    let zone = |i: usize| {
        let ya = rows[i].bottom_at(w / 2.0).ceil() as i64 + 1;
        let yb = if i + 1 == rows.len() { ink.bin.h as i64 } else { rows[i + 1].top_at(w / 2.0).floor() as i64 };
        (ya, yb)
    };
    // 本页一行字的高：各词带里够高够密的墨截的中位高（两行挤成一截的、弧与点凑的一截都是少数）
    let all: Vec<f64> = (0..rows.len())
        .flat_map(|i| {
            let (ya, yb) = zone(i);
            // 歌词字不比数字小多少：矮的一截（减时线没认全剩下的、弧与点凑的）不参加估行高
            let h = rows[i].h();
            cut_lines(ink, &claims, rows[i].band.slope, ya, yb, h * 0.5, None).into_iter().map(|l| (l.1 - l.0 + 1) as f64).filter(move |&v| v >= h * 0.9)
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
        let mut lines = cut_lines(ink, &claims, row.band.slope, ya, yb, h * 0.5, (one > 0.0).then_some(one));
        if last {
            // 谱后：只收紧跟着的几行（行距不过一行高），至多收到前面各行见过的段数
            let mut keep = 0;
            for (k, l) in lines.iter().enumerate() {
                let gap = if k == 0 { l.0 - ya } else { l.0 - lines[k - 1].1 };
                if gap as f64 > h * 1.6 || (max_verses > 0 && k >= max_verses) {
                    break;
                }
                keep = k + 1;
            }
            let rest = lines.split_off(keep);
            stanza_lines = rest;
        }
        let note_ix: Vec<usize> = (0..notes[i].nums.len()).filter(|&k| notes[i].nums[k].digit != 0).collect();
        let note_xs: Vec<f64> = note_ix.iter().map(|&k| notes[i].nums[k].bbox.cx()).collect();
        let mut verse = 0usize;
        for (y0, y1) in lines {
            let chars = read_line(ink, &claims, ocr, row.band.slope, y0, y1, 0, ink.bin.w as i64);
            let text: String = chars.iter().map(|c| c.ch).collect();
            if std::env::var("OMR_JP_DEBUG").is_ok() {
                eprintln!("行{i} 词带 y{y0}-{y1}: {text}");
            }
            // 下一行谱头顶上的和弦行、弧与点凑成的一截不是歌词
            let near_next = !last && (yb - y1) as f64 <= h * 1.3;
            let (cov, cnt) = chords::coverage(&text);
            let chordish = chords::is_chord_coverage(cov, cnt) && !text.chars().any(is_han);
            if (!last && chordish) || (near_next && han_count(&text) < 2) {
                continue;
            }
            // 没认全的减时线、弧凑成的一截：比一行字矮得多，或读出来只有横杠
            let junk = text.chars().filter(|&c| is_han(c)).all(|c| "一二三".contains(c)) && (((y1 - y0 + 1) as f64) < one * 0.75 || !text.chars().any(|c| c.is_ascii_alphabetic()));
            if junk || note_xs.is_empty() {
                continue;
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
            }
            if labels[i].len() <= verse {
                labels[i].resize(verse + 1, String::new());
            }
            labels[i][verse] = lr.label.unwrap_or_default();
            regions.push(TextRegion { text, bbox: Rect::new(chars.first().map_or(0.0, |c| c.x0), y0 as f64, chars.last().map_or(0.0, |c| c.x1) - chars.first().map_or(0.0, |c| c.x0), (y1 - y0 + 1) as f64) });
            verse += 1;
        }
        max_verses = max_verses.max(verse);
    }
    stanzas(ink, &claims, rows, notes, labels, ocr, &stanza_lines);
}

/// 谱后单独排版的附段歌词（诗行，不跟音符对齐）：以段号起头的一段，字数与第 1 段前几行谱的字位数对得上（差不过 2）时，
/// 按第 1 段的字位骨架逐字落到音上。分栏排的按栏从左到右、栏内从上到下读。
fn stanzas(ink: &Ink, claims: &Claims, rows: &[RowFrame], notes: &mut [RowNotes], labels: &mut [Vec<String>], ocr: &CachedOcr, lines: &[(i64, i64)]) {
    if lines.is_empty() || rows.is_empty() {
        return;
    }
    let slope = rows[rows.len() - 1].band.slope;
    let hh = median(&lines.iter().map(|l| (l.1 - l.0 + 1) as f64).collect::<Vec<_>>(), 1.0);
    // 各段文字，带栏位（段左缘）
    let mut segs: Vec<(f64, i64, Vec<Ch>)> = Vec::new();
    for &(y0, y1) in lines {
        for seg in read_segs(ink, claims, ocr, slope, y0, y1, 0, ink.bin.w as i64) {
            if std::env::var("OMR_JP_DEBUG").is_ok() {
                eprintln!("谱后 y{y0}: {}", seg.iter().map(|c| c.ch).collect::<String>());
            }
            if let Some(x) = seg.first().map(|c| c.x0) {
                segs.push((x, y0, seg));
            }
        }
    }
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
    // 以段号起头的切成段
    let mut blocks: Vec<(String, Vec<Ch>)> = Vec::new();
    for (_, _, seg) in segs {
        let text: String = seg.iter().map(|c| c.ch).collect();
        if text.trim_start().starts_with("注") {
            break;
        }
        let lead = seg.iter().position(|c| c.ch != ' ' && c.ch != '(' && c.ch != '（').unwrap_or(0);
        let c0 = seg[lead].ch;
        let digits = seg[lead..].iter().take_while(|c| c.ch.is_ascii_digit()).count();
        let label = if CN_NUM.contains(c0) && seg.len() > lead + 2 {
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
                blocks.push((l, body.to_vec()));
            }
            None => {
                if let Some(b) = blocks.last_mut() {
                    b.1.push(Ch { ch: ' ', x0: 0.0, x1: 0.0 });
                    b.1.extend(seg);
                }
            }
        }
    }
    // 第 1 段的字位骨架：各行里第 1 段有字的音
    let slots: Vec<Vec<usize>> = notes.iter().map(|rn| (0..rn.nums.len()).filter(|&k| rn.nums[k].lyrics.first().is_some_and(|t| !t.is_empty())).collect()).collect();
    let base = notes.iter().find(|rn| !rn.nums.is_empty()).map_or(1, |rn| rn.nums.iter().map(|n| n.lyrics.len()).max().unwrap_or(1)).max(1);
    for (bi, (label, chars)) in blocks.iter().enumerate() {
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
static KEY_BARE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*([b♭#♯]?)([A-G])([b♭#♯]?)(m?)\s*(?:调|大调|\d{1,2}\s*[/／]\s*\d)").unwrap());
static METER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d{1,2})\s*[/／]\s*(\d{1,2})").unwrap());
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
    let w = ink.bin.w as f64;
    let top = rows[0].top_at(w / 2.0);
    let zone = Rect::new(0.0, 0.0, w, (top - num_h * 0.3).max(1.0));
    let crop = ink.strip(&zone, 0);
    let boxes = ocr.detect(&crop).unwrap_or_default();
    let mut lines: Vec<WordLine> = Vec::new();
    for b in boxes {
        if b.h < num_h * 0.35 {
            continue;
        }
        let strip = ink.strip(&b, 0);
        let Ok(got) = ocr.read_line(&strip) else { continue };
        let text: String = got.iter().flat_map(|c| c.ch.chars()).map(fold).collect();
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
    let mut rest: Vec<WordLine> = Vec::new();
    let mut number: Option<(String, f64)> = None;
    for l in lines {
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
        if let Some(c) = METER.captures(&l.text) {
            if let (Ok(a), Ok(b)) = (c[1].parse::<u32>(), c[2].parse::<u32>()) {
                if (1..=12).contains(&a) && [2, 4, 8, 16].contains(&b) {
                    score.beats = a;
                    score.beat_type = b;
                    used = true;
                }
            }
        }
        if let Some((bpm, _)) = words::metronome(&l.text) {
            score.tempo = Some(bpm);
            used = true;
        }
        if let Some(c) = NUMBER.captures(&l.text) {
            if l.h >= num_h * 0.6 {
                number = Some((c[1].to_string(), l.x + l.w / 2.0));
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
        if let Some((n, x)) = number {
            score.number_side = Some(if x > t.rect.0 + t.rect.2 / 2.0 { "right" } else { "left" });
            score.number = Some(n);
        }
    } else if let Some((n, _)) = number {
        score.number = Some(n);
    }
}

/// 叠排的拍号：上下两个数字、横向对齐、中间隔一道横线的空当。只在行内文字没读出 `4/4` 时用。
fn stacked_meter(ink: &Ink, top: f64, num_h: f64, ocr: &CachedOcr, score: &mut RecognizedScore) {
    let digitish: Vec<&crate::prep::Comp> = ink.comps.iter().filter(|k| k.rect.bottom() < top && k.rect.h >= num_h * 0.5 && k.rect.h <= num_h * 1.4 && k.rect.w >= k.rect.h * 0.3 && k.rect.w <= k.rect.h * 1.0).collect();
    let mut best: Option<(f64, u32, u32)> = None;
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
                if (1..=12).contains(&x) && [2, 4, 8].contains(&y) && best.is_none_or(|p| a.rect.y > p.0) {
                    best = Some((a.rect.y, x, y));
                }
            }
        }
    }
    if let Some((_, x, y)) = best {
        score.beats = x;
        score.beat_type = y;
    }
}

/// 页眉里汉字多的行才当标题候选（给调用方过滤用）。
pub fn has_han(s: &str) -> bool {
    s.chars().any(is_han)
}

/// 行里各段文字高的中位（排查用）。
pub fn median_h(lines: &[TextLine]) -> f64 {
    median(&lines.iter().map(|l| (l.y1 - l.y0 + 1) as f64).collect::<Vec<_>>(), 0.0)
}

/// 一行谱头顶上的和弦行：上方带里切行读字，整行是和弦记号的，各记号按左缘挂到它底下（或左边最近）的音上；
/// 一个音上已有和弦的记成这个音时值内后面换的和弦。
pub fn chords_above(ink: &Ink, row: &RowFrame, rn: &mut RowNotes, ocr: &CachedOcr, y_min: f64, regions: &mut Vec<TextRegion>) {
    let h = row.h();
    let w = ink.bin.w as f64;
    let top = row.top_at(w / 2.0);
    let ya = y_min.max(top - h * 2.8).max(0.0) as i64;
    let yb = top.floor() as i64 - 1;
    if rn.nums.is_empty() {
        return;
    }
    let claims = Claims::new(ink, std::iter::empty());
    for (y0, y1) in cut_lines(ink, &claims, row.band.slope, ya, yb, h * 0.35, None) {
        let chars = read_line(ink, &claims, ocr, row.band.slope, y0, y1, 0, ink.bin.w as i64);
        let text: String = chars.iter().map(|c| c.ch).collect();
        if std::env::var("OMR_JP_DEBUG").is_ok() {
            eprintln!("上方带 y{y0}-{y1}: {text}");
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
