//! 文字行的分类与归属（M4 4.2~4.5）：歌词行归上面那行谱、逐行编号；和弦、节拍器归下面那行谱；
//! 力度、跳转、表情术语归近的那行。只定「是什么、在哪一行谱的哪个 x」，挂到哪个音由整曲拼接时按 x 定。
use super::lines::{Band, GeoLine, Seg};
use crate::page::Layout;
use dolce_omr_core::image::Rect;
use dolce_omr_core::sheet::score::Dir;
use dolce_omr_core::text::chars::{han_count, latin_count, script_of, Script};
use dolce_omr_core::text::lyrics::{syllables, LyricRow};
use dolce_omr_core::text::{chords, words, Ch};

/// 第一行歌词离谱表不过这么多格（下面还有谱行的带里，离上面谱表比离下面近的也收、两行谱的系统里两行之间的不限：低音多的谱行下歌词离谱表七格开外，新编 176；
/// 副歌的歌词夹在高低音谱表正中，新编 294）；
/// 之后各行与上一行的空隙不过较矮那行行高的这个比例。
const LYRIC_FIRST: f64 = 7.0;
const LYRIC_GAP: f64 = 0.8;
/// 歌词行至少这么高（相对线距）：再矮的是指法、连音数字、碎墨读出来的字。
const LYRIC_MIN_H: f64 = 1.3;
/// 接不上的上方几行合起来不过这么多个音节，算假行。
const WEAK_SYLS: usize = 6;
/// 一栏的头一行歌词不到这么多个音节的，要再看像不像字。
const LYRIC_START: usize = 3;
/// 两行横向交叠过较窄那行的这个比例，算上下对着。
const XOVER: f64 = 0.3;
/// 和弦记号离下面那行谱的首线不过这么多格（混排谱的和弦印在简谱行上方），且比离上面那行谱近。
const CHORD_REACH: f64 = 9.0;
/// 一页至少读出这么多个和弦记号才算有和弦。
const MIN_CHORDS: usize = 3;
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
    /// 字墨的框（页内工作坐标；源框用）。
    pub rect: Rect,
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

/// 一行里左边一截汉字词、右边一截拉丁词（主歌的行右边接着副歌的英文行，高度碰巧对上）：拆成两行。
/// 两截都要够长才拆（汉字两个以上、拉丁字母八个以上）。
fn split_scripts(l: &GeoLine) -> Vec<GeoLine> {
    let sc: Vec<Script> = l.segs.iter().map(|s| script_of(&s.text())).collect();
    let han: usize = l.segs.iter().zip(&sc).filter(|(_, s)| **s == Script::Han).map(|(g, _)| han_count(&g.text())).sum();
    let lat: usize = l.segs.iter().zip(&sc).filter(|(_, s)| **s == Script::Latin).map(|(g, _)| latin_count(&g.text())).sum();
    if han < 2 || lat < 8 {
        return vec![l.clone()];
    }
    // 按文字种类连着的归一组（数字、符号跟着前一组）
    let mut groups: Vec<(Script, Vec<Seg>)> = Vec::new();
    for (g, s) in l.segs.iter().zip(sc) {
        match groups.last_mut() {
            Some((cur, v)) if s == Script::Other || s == *cur => v.push(g.clone()),
            Some((cur, v)) if *cur == Script::Other => {
                *cur = s;
                v.push(g.clone());
            }
            _ => groups.push((s, vec![g.clone()])),
        }
    }
    groups
        .into_iter()
        .map(|(_, segs)| {
            let y0 = segs.iter().map(|s| s.rect.y).fold(f64::MAX, f64::min);
            let y1 = segs.iter().map(|s| s.rect.bottom()).fold(f64::MIN, f64::max);
            GeoLine { y0, y1, segs }
        })
        .collect()
}

/// 小节号：纯数字（三位以内）、横向在下面那行谱左端 [`BARNO_X`] 格以内、紧贴着那行谱的上方（[`BARNO_GAP`] 格以内）。
const BARNO_X: f64 = 3.0;
const BARNO_GAP: f64 = 2.5;

/// 行里剔掉小节号那一段（和弦行开头印着小节号，整行就不像和弦行了）；剔完空了回 None。
fn strip_bar_numbers(f: &Layout, b: &Band, l: &GeoLine) -> Option<GeoLine> {
    let Some(z) = b.below else { return Some(l.clone()) };
    let s = &f.staves[z];
    let is_no = |g: &Seg| {
        let t = g.text();
        let t = t.trim();
        !t.is_empty() && t.len() <= 3 && t.chars().all(|c| c.is_ascii_digit()) && (g.rect.x - s.left).abs() <= BARNO_X * s.space() && (s.top(g.rect.cx()) - g.rect.bottom()) / s.space() <= BARNO_GAP
    };
    if !l.segs.iter().any(is_no) {
        return Some(l.clone());
    }
    let segs: Vec<Seg> = l.segs.iter().filter(|g| !is_no(g)).cloned().collect();
    if segs.is_empty() {
        return None;
    }
    let y0 = segs.iter().map(|s| s.rect.y).fold(f64::MAX, f64::min);
    let y1 = segs.iter().map(|s| s.rect.bottom()).fold(f64::MIN, f64::max);
    Some(GeoLine { y0, y1, segs })
}

/// 段落标签（`(副歌)`、`【副歌】`、`副歌：`）：不是唱词。
fn section_label(t: &str) -> bool {
    let core: String = t.chars().filter(|c| !"()（）[]【】:：. 　".contains(*c)).collect();
    ["副歌", "和声", "合唱", "齐唱", "独唱", "领唱", "女声", "男声", "重唱", "尾声", "副歌)"].contains(&core.as_str())
}

fn unspaced(t: &str) -> String {
    t.chars().filter(|c| !c.is_whitespace()).collect()
}

/// 整行都是音乐术语 / 力度 / 跳转记号（不是歌词）。
fn is_term_line(text: &str) -> bool {
    if han_count(text) > 0 || text.chars().count() > 32 || !words::has_staff_term(text) && words::dynamic(text).is_none() && words::jump(text).is_none() {
        return false;
    }
    let words: Vec<&str> = text
        .split(|c: char| c.is_whitespace() || c == '.' || c == ',' || c == ';' || c == ':' || c == '(' || c == ')')
        .filter(|w| !w.is_empty())
        .collect();
    !words.is_empty()
        && words.iter().all(|w| {
            words::has_staff_term(w)
                || words::dynamic(w).is_some()
                || words::jump(w).is_some()
                || w.chars().all(|c| c.is_ascii_digit())
                || matches!(
                    w.to_lowercase().as_str(),
                    "a" | "al" | "dal" | "da" | "con" | "e" | "ed" | "et" | "ma" | "non" | "troppo" | "in" | "del" | "alla" | "col" | "senza" | "more" | "less" | "very" | "with" | "and" | "or" | "s" | "t" | "b"
                )
        })
}

/// 像歌词的一行：两个以上汉字，或以拉丁字母为主的一串词。
fn lyric_like(text: &str) -> bool {
    let total = text.chars().filter(|c| !c.is_whitespace()).count();
    let (h, l) = (han_count(text), latin_count(text));
    (h >= 2 && h * 2 >= total.saturating_sub(l)) || (l >= 4 && l * 10 >= total * 6)
}

/// 一段字是不是记号 / 文字指示；是的话交出来。`above`：印在所归谱行的上方。
fn mark_of(seg: &Seg, above: bool, chord_ok: bool) -> Vec<Mark> {
    let t = seg.text();
    let t = t.trim();
    let x = seg.rect.x;
    let r = seg.rect;
    // 一截字（`a..b` 个字）的框，纵向取整段
    let span = |a: usize, b: usize| -> Rect {
        let (x0, x1) = (seg.chars.get(a).map_or(r.x, |c| c.x0), seg.chars.get(b.max(a + 1) - 1).map_or(r.right(), |c| c.x1));
        Rect::new(x0, r.y, (x1 - x0).max(0.0), r.h)
    };
    // 力度只收两个字母以上的：单个 p / f 从杂墨里读出来的太多（延音线的一截、符尾），留给按字形认的那一路
    if let Some(d) = words::dynamic(t).filter(|d| d.len() >= 2) {
        return vec![Mark { x: seg.rect.cx(), rect: r, dir: Dir::Dynamics(d.to_string()) }];
    }
    // 节拍器从等号起解析（前面可以是汉字的速度提示）
    let eq = seg.chars.iter().position(|c| c.ch == '=' || c.ch == '＝').unwrap_or(0);
    let tail: String = seg.chars[eq..].iter().map(|c| c.ch).collect();
    if let Some((n, circa)) = words::metronome(&tail).filter(|_| seg.chars.get(eq).is_some_and(|c| c.ch == '=' || c.ch == '＝')) {
        // 「Andante ♩= 76」「欢快 热烈地 ♩= 144」：等号前（连同贴着它的音符字、开括号）是术语或中文速度提示，单挂一条；节拍器的 x 取音符字（或等号）
        let cs = &seg.chars;
        let mut k = eq;
        while k > 0 && cs[k - 1].ch == ' ' {
            k -= 1;
        }
        // 等号前单独一个字（音符字形、矢量字体里代音符的 q）：它前面是空格、开括号或段首
        let mut start = if k > 0 && (k == 1 || matches!(cs[k - 2].ch, ' ' | '(')) { k - 1 } else { k };
        while start > 0 && matches!(cs[start - 1].ch, '(' | ' ') {
            start -= 1;
        }
        let mut out = vec![Mark { x: cs.get(start).map_or(x, |c| c.x0), rect: span(start, cs.len()), dir: Dir::Metronome { per_minute: n, circa } }];
        let pre: String = cs[..start].iter().map(|c| c.ch).collect();
        // 行首的排练号（【A】）不算
        let pre = pre.trim();
        let pre = match pre.strip_prefix('【').and_then(|r| r.split_once('】')) {
            Some((_, rest)) => rest.trim(),
            None => pre,
        };
        let han_hint = (2..=12).contains(&han_count(pre)) && !pre.chars().any(|c| c.is_ascii_digit());
        if (words::has_staff_term(pre) && latin_count(pre) >= 3 && han_count(pre) == 0) || han_hint {
            out.insert(0, Mark { x, rect: span(0, start), dir: Dir::Words { text: pre.to_string(), above, jump: None } });
        }
        return out;
    }
    if let Some(j) = words::jump(t) {
        return vec![Mark { x, rect: r, dir: Dir::Words { text: t.to_string(), above, jump: Some(j) } }];
    }
    if chord_ok && chords::is_annotation_line(&unspaced(t)) {
        // 切词在逐字序列上做（下标对得上字位）；补出来的空格先去掉——根音与抬高的后缀之间有道白（`C sus4`）
        let cs: Vec<&Ch> = seg.chars.iter().filter(|c| c.ch != ' ').collect();
        let s: String = cs.iter().map(|c| c.ch).collect();
        let x_at = |i: usize| cs.get(i).map_or(0.0, |c| c.cx());
        return chords::split_tokens(&chords::blank_non_chord(&s), Some(&x_at))
            .into_iter()
            .map(|tk| {
                let last = cs[(tk.index + tk.tok.chars().count()).min(cs.len()) - 1];
                let x0 = cs[tk.index].x0;
                Mark { x: x0, rect: Rect::new(x0, r.y, (last.x1 - x0).max(0.0), r.h), dir: Dir::Harmony(chords::normalize(&tk.tok)) }
            })
            .collect();
    }
    if words::has_staff_term(t) && latin_count(t) >= 3 && t.chars().count() <= 32 && han_count(t) == 0 {
        return vec![Mark { x, rect: r, dir: Dir::Words { text: t.to_string(), above, jump: None } }];
    }
    Vec::new()
}

/// 各条带的行 → 各行谱的歌词与记号（与 `staves` 同序）。
pub fn classify(f: &Layout, bands: &[Band]) -> Vec<RowText> {
    let mut rows: Vec<RowText> = (0..f.staves.len()).map(|_| RowText::default()).collect();
    for b in bands {
        // 歌词链：从上面那行谱往下数。已收下的歌词行 (x0, x1, y1, 行高, 拉丁)；`blocked`：链断处那行的横向范围（它下面的不再收）
        let mut chain: Vec<(f64, f64, f64, f64, bool)> = Vec::new();
        // 链上各行在 `rows[a].lyrics` 里的下标与音节数（与 `chain` 同序）
        let mut chain_at: Vec<(usize, usize)> = Vec::new();
        let mut blocked: Vec<(f64, f64)> = Vec::new();
        // 上下两行谱同属一个系统（高低音谱表之间的歌词带）
        // 只看两行谱的系统（四声部大谱表）：合唱谱多行系统里声部行与钢琴行之间印的中文表情指示会被收成歌词（望十架、紫袍荆冠）
        let in_system = matches!((b.above, b.below), (Some(a), Some(z)) if f.systems.iter().any(|s| s.staves.len() == 2 && s.staves.contains(&a) && s.staves.contains(&z)));
        let lines: Vec<GeoLine> = b.lines.iter().filter_map(|l| strip_bar_numbers(f, b, l)).flat_map(|l| split_scripts(&l)).collect();
        // 页脚：从版权声明那行起往下都是（版权、复印说明、网址、页码），不当歌词与记号
        let footer = lines.iter().position(|l| dolce_omr_core::text::header::is_rights(&line_chars(l).iter().map(|c| c.ch).collect::<String>())).filter(|_| b.below.is_none());
        for l in &lines[..footer.unwrap_or(lines.len())] {
            let cx = l.cx();
            let d_above = b.above.map(|a| {
                let s = &f.staves[a];
                (l.y0 - s.bottom(cx.clamp(s.left, s.right))) / s.space()
            });
            // 下面那行谱上方印着简谱行的（混排谱），从最上面那条简谱行的上沿量起：和弦印在简谱行之上
            let d_below = b.below.map(|z| {
                let s = &f.staves[z];
                let lift = f.bands.iter().filter(|k| k.anchor == z && k.y1 <= 0.0).map(|k| k.y0).fold(0.0, f64::min);
                (s.top(cx.clamp(s.left, s.right)) + lift - l.y1) / s.space()
            });
            let chars = line_chars(l);
            let text: String = chars.iter().map(|c| c.ch).collect();
            let (x0, x1) = (l.segs.iter().map(|s| s.rect.x).fold(f64::MAX, f64::min), l.segs.iter().map(|s| s.rect.right()).fold(f64::MIN, f64::max));
            let over = |a0: f64, a1: f64| a1.min(x1) - a0.max(x0) > XOVER * (a1 - a0).min(x1 - x0);
            // 和弦行优先：贴着下面那行谱、整行是和弦记号
            let chord_zone = d_below.is_some_and(|d| d <= CHORD_REACH && d_above.is_none_or(|a| d < a));
            let chord_line = chord_zone && chords::is_annotation_line(&unspaced(&text));
            let tall = b.above.is_some_and(|a| l.h() >= LYRIC_MIN_H * f.staves[a].space());
            if std::env::var("OMR_TEXT_DEBUG").is_ok() {
                eprintln!("分类 y{:.0} {text:?}：距上 {d_above:?} 距下 {d_below:?} 高够 {tall} 像歌词 {} 和弦行 {chord_line} 链 {}", l.y0, lyric_like(&text), chain.len());
            }
            if let Some(a) = b.above.filter(|_| !chord_line && tall && !is_term_line(&text) && lyric_like(&text) && !blocked.iter().any(|&(a0, a1)| over(a0, a1))) {
                // 横向盖得住它的上方歌词行：没有就是这一栏的头一行（看离谱表多远），有就看与最下面那行的空隙
                let mut prev: Vec<(f64, f64, f64, f64, bool)> = chain.iter().filter(|c| over(c.0, c.1)).copied().collect();
                let gap_ok = |prev: &[(f64, f64, f64, f64, bool)]| match prev.iter().map(|c| (c.2, c.3)).max_by(|p, q| p.0.total_cmp(&q.0)) {
                    None => d_above.is_some_and(|d| d <= LYRIC_FIRST || in_system || d_below.is_some_and(|z| d < z)),
                    Some((bottom, h)) => l.y0 - bottom <= LYRIC_GAP * h.min(l.h()),
                };
                let mut ok = gap_ok(&prev);
                // 接不上的上方那几行合起来没几个字（碎墨读成的假行），这一行自己离谱表不远：丢掉它们、从这一行起头
                if !ok && !prev.is_empty() && d_above.is_some_and(|d| d <= LYRIC_FIRST) {
                    let weak: usize = chain.iter().zip(&chain_at).filter(|(c, _)| over(c.0, c.1)).map(|(_, a)| a.1).sum();
                    if weak <= WEAK_SYLS {
                        for (c, at) in chain.iter().zip(&chain_at) {
                            if over(c.0, c.1) {
                                rows[a].lyrics[at.0].row.syls.clear();
                            }
                        }
                        let keep: Vec<bool> = chain.iter().map(|c| !over(c.0, c.1)).collect();
                        let mut k = keep.iter();
                        chain.retain(|_| *k.next().unwrap());
                        let mut k = keep.iter();
                        chain_at.retain(|_| *k.next().unwrap());
                        prev.clear();
                        ok = true;
                    }
                }
                if ok {
                    // 行里夹着的跳转记号（行尾的 Fine、D.C.）单独挂
                    let mut lyric_chars: Vec<Ch> = Vec::new();
                    for s in &l.segs {
                        if section_label(s.text().trim()) {
                            continue;
                        }
                        if let Some(j) = words::jump(s.text().trim()) {
                            rows[a].marks.push(Mark { x: s.rect.x, rect: s.rect, dir: Dir::Words { text: s.text().trim().to_string(), above: false, jump: Some(j) } });
                            continue;
                        }
                        if let (Some(p), Some(n)) = (lyric_chars.last(), s.chars.first()) {
                            let sep = Ch { ch: ' ', x0: p.x1, x1: n.x0 };
                            lyric_chars.push(sep);
                        }
                        lyric_chars.extend(s.chars.iter().cloned());
                    }
                    let row = syllables(&lyric_chars);
                    // 一栏的头一行要有三个以上音节：碎墨读出来的一两个字（「二 一」）不开头
                    // 一栏的头一行：一两个音节的要像字——碎墨读出来的多是笔画极少的字（「二 一」「十」）
                    let debris = row.syls.len() < LYRIC_START && row.syls.iter().all(|s| s.text.chars().all(|c| "一二三十丨口日中甲由田曰工上下".contains(c) || !dolce_omr_core::text::chars::is_han(c)) && s.text.chars().any(dolce_omr_core::text::chars::is_han));
                    if !row.syls.is_empty() && !(prev.is_empty() && debris) {
                        let latin = script_of(&row.syls.iter().map(|s| s.text.as_str()).collect::<String>()) == Script::Latin;
                        // 行号 = 上方同种文字、横向盖得住它的行数 + 1（副歌一行夹在主歌几行右边，是它那一栏的第 1 行）
                        let number = 1 + prev.iter().filter(|c| c.4 == latin).count() as u8;
                        chain_at.push((rows[a].lyrics.len(), row.syls.len()));
                        rows[a].lyrics.push(LyricLine { number, latin, row, y0: l.y0, y1: l.y1 });
                        chain.push((x0, x1, l.y1, l.h(), latin));
                        continue;
                    }
                } else if !prev.is_empty() {
                    // 链断了：这一栏后面的成行文字是脚注、版权，不再当歌词
                    blocked.push((x0, x1));
                }
            }
            // 记号与文字指示：逐段看，归近的那行谱
            let to_below = match (d_above, d_below) {
                (Some(a), Some(z)) => z < a,
                (None, _) => true,
                _ => false,
            };
            let (si, dist) = if to_below { (b.below, d_below) } else { (b.above, d_above) };
            let (Some(si), Some(dist)) = (si, dist) else { continue };
            if dist > MARK_REACH.max(if chord_zone { CHORD_REACH } else { 0.0 }) {
                continue;
            }
            // 和弦只归下面那行谱
            let chord_ok = chord_zone;
            for s in &l.segs {
                for m in mark_of(s, to_below, chord_ok) {
                    let row = if matches!(m.dir, Dir::Harmony(_) | Dir::Metronome { .. }) { b.below.unwrap_or(si) } else { si };
                    rows[row].marks.push(m);
                }
            }
        }
    }
    for r in rows.iter_mut() {
        r.lyrics.retain(|l| !l.row.syls.is_empty());
    }
    // 整页读出的和弦记号不到三个的不要：没有和弦的谱面上，延长记号、弧头偶尔读成一个 C、D
    if rows.iter().flat_map(|r| r.marks.iter()).filter(|m| matches!(m.dir, Dir::Harmony(_))).count() < MIN_CHORDS {
        for r in rows.iter_mut() {
            r.marks.retain(|m| !matches!(m.dir, Dir::Harmony(_)));
        }
    }
    fold_bilingual(f, &mut rows);
    rows
}

/// 中英对照的闭合谱：汉字词印在两行谱之间、英文词印在下面那行谱之下，唱的是同一条旋律——
/// 同系统里上一行谱有汉字词、下一行谱的词全是拉丁字母的，拉丁那几行接到上一行谱的词后面。
fn fold_bilingual(f: &Layout, rows: &mut [RowText]) {
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
