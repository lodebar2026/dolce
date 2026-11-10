//! 整曲（M7，骨架）：各页的系统按次序接成声部与小节，谱号 / 调号 / 拍号跨行跨页沿用，交出结果模型与版面摘要。
//!
//! 现在的声部指派很简单：行数最多的系统定声部数，一行谱一个声部；行数少的系统按谱号保序配到声部上（并列时靠下——
//! 少印的多半是上面的人声行，伴奏在最下）。花括号合大谱表、按歌词 / 音域 / 标签指派留到整曲定稿那一期。
use crate::attrs::RowAttrs;
use crate::frame::bars::BarStyle;
use crate::page::Page;
use dolce_omr_sheet::music::{Clef, Key};
use dolce_omr_sheet::score::{Attrs, Measure, Part, Score};

/// 同系统各行的小节线按 x 归成一处的容差（相对线距）。
const BOUND_XTOL: f64 = 1.6;
/// 最后一条小节线之后还剩这么多格的谱线，算没印右线的半截小节。
const OPEN_TAIL: f64 = 3.0;

/// 版面摘要里一行谱（形状见私有仓库 `chorus-opslib.mjs::recLayoutOf`）。
pub struct RowLayout {
    pub row: usize,
    pub part: usize,
    pub from: usize,
    pub to: usize,
    pub space: f64,
}

pub struct SystemLayout {
    pub page: usize,
    pub top: f64,
    pub bars: usize,
    pub rows: Vec<RowLayout>,
}

pub struct Song {
    pub score: Score,
    pub systems: Vec<SystemLayout>,
}

/// 一个系统的小节边界。
struct Bound {
    x: f64,
    style: BarStyle,
    /// 左边 / 右边有反复点（过半的行都有才算）。
    rep_end: bool,
    rep_start: bool,
}

fn bounds(page: &Page, rows: &[usize]) -> (Vec<Bound>, bool) {
    let f = &page.frame;
    let sp = f.unit.space;
    let mut all: Vec<(f64, BarStyle, bool, bool)> = rows
        .iter()
        .flat_map(|&i| f.bars[i].iter().filter(move |b| b.x > page.attrs[i].lead_end).map(|b| (b.x, b.style, b.repeat_left, b.repeat_right)))
        .collect();
    all.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<Bound> = Vec::new();
    let mut i = 0;
    while i < all.len() {
        let mut j = i + 1;
        while j < all.len() && all[j].0 - all[j - 1].0 <= sp * BOUND_XTOL {
            j += 1;
        }
        let c = &all[i..j];
        if c.len() * 2 >= rows.len() {
            // 样式取各行里最多的那种非普通样式（过半的行是普通线才算普通）
            let special: Vec<BarStyle> = c.iter().map(|e| e.1).filter(|s| *s != BarStyle::Regular).collect();
            let style = if special.len() * 2 >= c.len() { most(&special) } else { BarStyle::Regular };
            let rep_end = c.iter().filter(|e| e.2).count() * 2 > c.len();
            let rep_start = c.iter().filter(|e| e.3).count() * 2 > c.len();
            out.push(Bound { x: c[c.len() / 2].0, style, rep_end, rep_start });
        }
        i = j;
    }
    let right = rows.iter().map(|&i| f.staves[i].right).fold(f64::INFINITY, f64::min);
    let open = out.last().is_none_or(|b| right - b.x > sp * OPEN_TAIL);
    (out, open)
}

fn most(v: &[BarStyle]) -> BarStyle {
    let mut best = (0, v[0]);
    for s in v {
        let n = v.iter().filter(|t| *t == s).count();
        if n > best.0 {
            best = (n, *s);
        }
    }
    best.1
}

/// 行数少的系统的各行配到哪几个声部：保序，谱号不同的罚一分，并列取靠下的。
fn assign(clefs: &[Option<Clef>], slots: &[Option<Clef>]) -> Vec<usize> {
    let (n, m) = (clefs.len(), slots.len());
    if n >= m {
        return (0..n).map(|i| i.min(m.saturating_sub(1))).collect();
    }
    // best[i][j]：第 i 行配声部 j 时前 i 行的最小罚分
    let cost = |i: usize, j: usize| match (clefs[i], slots[j]) {
        (Some(a), Some(b)) if a.sign != b.sign => 2,
        (Some(a), Some(b)) if a != b => 1,
        _ => 0,
    };
    let mut best = vec![vec![u32::MAX; m]; n];
    for j in 0..m {
        best[0][j] = cost(0, j);
    }
    for i in 1..n {
        for j in i..m {
            let prev = (i - 1..j).map(|k| best[i - 1][k]).min().unwrap_or(u32::MAX);
            if prev != u32::MAX {
                best[i][j] = prev + cost(i, j);
            }
        }
    }
    let mut out = vec![0; n];
    let mut hi = m;
    for i in (0..n).rev() {
        let lo = i;
        let j = (lo..hi).rev().min_by_key(|&j| best[i][j]).unwrap();
        out[i] = j;
        hi = j;
    }
    out
}

/// 各系统的调号读数（同系统互证过的）顺着乐曲定下来：没读出的沿用；孤零零一个系统与前后都不同的照前后改；
/// 收得不干净（后面还跟着像升降号的墨）又比邻近系统少几个同种记号的，照邻近的补——少读常见，转调少见且前后系统会一致。
fn settle_keys(read: &[Option<(i8, bool)>]) -> Vec<i8> {
    settle(read, |a, b| a.unsigned_abs() < b.unsigned_abs() && (a == 0 || (a > 0) == (b > 0))).into_iter().map(|v| v.unwrap_or(0)).collect()
}

/// 一串按乐曲次序的读数（值, 把握大）定下来：没读出的沿用前一个（开头的取后面第一个）；一段读数夹在两段相同的读数之间、
/// 自己又只有一个或没把握的，照两边改；没把握又是邻段「少读」（`prefix(本段, 邻段)`）的照邻段补；开头结尾孤零零一个没把握的照邻段改。
fn settle<T: Copy + PartialEq>(read: &[Option<(T, bool)>], prefix: impl Fn(T, T) -> bool) -> Vec<Option<T>> {
    let n = read.len();
    let mut k: Vec<Option<T>> = read.iter().map(|r| r.map(|x| x.0)).collect();
    let sure: Vec<bool> = read.iter().map(|r| r.is_some_and(|x| x.1)).collect();
    for i in 1..n {
        if k[i].is_none() {
            k[i] = k[i - 1];
        }
    }
    for i in (0..n.saturating_sub(1)).rev() {
        if k[i].is_none() {
            k[i] = k[i + 1];
        }
    }
    if k.iter().any(|v| v.is_none()) {
        return k;
    }
    let mut k: Vec<T> = k.into_iter().map(|v| v.unwrap()).collect();
    for _ in 0..4 {
        let mut changed = false;
        let mut i = 0;
        while i < n {
            let mut j = i;
            while j + 1 < n && k[j + 1] == k[i] {
                j += 1;
            }
            let prev = (i > 0).then(|| k[i - 1]);
            let next = (j + 1 < n).then(|| k[j + 1]);
            let unsure = (i..=j).all(|t| !sure[t]);
            let single = i == j;
            let to = match (prev, next) {
                (Some(p), Some(q)) if p == q && (single || unsure) => Some(p),
                (Some(p), _) if unsure && prefix(k[i], p) => Some(p),
                (_, Some(q)) if unsure && prefix(k[i], q) => Some(q),
                (Some(p), None) if single && unsure => Some(p),
                (None, Some(q)) if single && unsure => Some(q),
                _ => None,
            };
            if let Some(v) = to {
                for t in i..=j {
                    k[t] = v;
                }
                changed = true;
            }
            i = j + 1;
        }
        if !changed {
            break;
        }
    }
    k.into_iter().map(Some).collect()
}

/// 把各页（按次序）拼成整曲。
pub fn assemble(pages: &[Page], title: Option<String>) -> Song {
    let nparts = pages.iter().flat_map(|p| p.frame.systems.iter().map(|s| s.staves.len())).max().unwrap_or(0);
    let mut parts: Vec<Part> = (0..nparts).map(|_| Part::default()).collect();
    // 各声部现行的谱号、调号
    let mut clef: Vec<Option<Clef>> = vec![None; nparts];
    let mut key: Vec<Option<Key>> = vec![None; nparts];
    let mut systems = Vec::new();
    let mut row_no = 0;
    // 各系统的调号（同系统互证后各行相同，取第一个读出来的行）
    let sys_keys: Vec<Option<(i8, bool)>> = pages
        .iter()
        .flat_map(|p| p.frame.systems.iter().map(move |sys| sys.staves.iter().filter_map(|&i| p.attrs[i].key.map(|k| (k.fifths, p.attrs[i].key_sure))).next()))
        .collect();
    let keys = settle_keys(&sys_keys);
    // 各系统的行配到哪几个声部；各声部逐系统的行首谱号读数顺着乐曲定下来（行首换谱号少见：孤零零一行读得不同的照前后改）
    let mut slots_all: Vec<Vec<usize>> = Vec::new();
    let mut clef_reads: Vec<Vec<Option<(Clef, bool)>>> = vec![Vec::new(); nparts];
    for page in pages {
        for sys in &page.frame.systems {
            let ra: Vec<&RowAttrs> = sys.staves.iter().map(|&i| &page.attrs[i]).collect();
            let slots = assign(&ra.iter().map(|a| a.clef).collect::<Vec<_>>(), &clef);
            for r in clef_reads.iter_mut() {
                r.push(None);
            }
            for (k, &p) in slots.iter().enumerate() {
                if let Some(c) = ra[k].clef {
                    *clef_reads[p].last_mut().unwrap() = Some((c, ra[k].clef_sure));
                    if ra[k].clef_sure || clef[p].is_none() {
                        clef[p] = Some(c);
                    }
                }
            }
            slots_all.push(slots);
        }
    }
    let clefs: Vec<Vec<Option<Clef>>> = clef_reads.iter().map(|r| settle(r, |_, _| false)).collect();
    let mut clef: Vec<Option<Clef>> = vec![None; nparts];
    let mut sys_no = 0;
    // 上一个系统行末没印右线（跨行劈开的小节）
    let mut prev_open = false;
    // 现行拍号
    let mut time: Option<dolce_omr_sheet::music::Time> = None;
    // 上一个系统末小节的宽度（相对它那一行常见的小节宽；没有为 0）
    let mut prev_tail = 0.0f64;
    for (pn, page) in pages.iter().enumerate() {
        let f = &page.frame;
        for (si, sys) in f.systems.iter().enumerate() {
            let sys_key = Key { fifths: keys[sys_no] };
            let slots = slots_all[sys_no].clone();
            let sys_i = sys_no;
            sys_no += 1;
            let rows = &sys.staves;
            let ra: Vec<&RowAttrs> = rows.iter().map(|&i| &page.attrs[i]).collect();
            let (mut bs, open) = bounds(page, rows);
            // 单独一根粗线不成样式（行末收尾的线扫出来常偏粗）：全曲最后一条当终止线，其余当普通线
            let last_sys = pn + 1 == pages.len() && si + 1 == f.systems.len();
            let nb = bs.len();
            for (j, b) in bs.iter_mut().enumerate() {
                if b.style == BarStyle::Heavy {
                    b.style = if last_sys && j + 1 == nb && !open { BarStyle::LightHeavy } else { BarStyle::Regular };
                }
            }
            // 跨行劈开的小节（暂按宽度估，音符层落地后改按拍数）：上一行末小节与这一行首小节都比本行常见的小节窄、合起来不过一个半
            let lead = rows.iter().map(|&i| page.attrs[i].lead_end).fold(f64::MIN, f64::max);
            let widths: Vec<f64> = bs.windows(2).map(|w| w[1].x - w[0].x).collect();
            let med = dolce_omr_core::geom::median(&widths, 0.0);
            let first_w = bs.first().map_or(f64::MAX, |b| b.x - lead);
            let first_r = if med > 0.0 { first_w / med } else { f64::MAX };
            let implicit = prev_open || (prev_tail > 0.0 && first_r < 0.7 && prev_tail < 0.85 && first_r + prev_tail <= 1.35);
            let tail_w = if !open && nb >= 2 { bs[nb - 1].x - bs[nb - 2].x } else { 0.0 };
            let count = bs.len() + open as usize;
            let from = parts.first().map_or(0, |p| p.measures.len());
            let mut used = vec![false; nparts];
            let mut layout = Vec::new();
            for (k, &i) in rows.iter().enumerate() {
                let p = slots[k];
                used[p] = true;
                let a = ra[k];
                let mut ms: Vec<Measure> = (0..count).map(|_| Measure::default()).collect();
                for j in 0..count {
                    // 行末没印右线的半截小节（`bs` 里没有这一条）：GT 记不了「没印」，照普通线写
                    let Some(b) = bs.get(j) else { continue };
                    if b.style != BarStyle::Regular {
                        ms[j].right = Some(b.style);
                    }
                    // 反复结束：点在线左，样式按细 + 粗；反复开始：点在线右，记在下一小节的左线上
                    if b.rep_end {
                        ms[j].repeat_end = true;
                        ms[j].right = Some(BarStyle::LightHeavy);
                    }
                    if b.rep_start && j + 1 < count {
                        ms[j + 1].repeat_start = true;
                        if !b.rep_end {
                            ms[j].right = None;
                        }
                    }
                }
                let first = from == 0;
                let mut at = Attrs::default();
                // 谱号：整曲定下来的那个（全曲都没读出的声部按高音谱号）
                let c = clefs[p][sys_i].unwrap_or(Clef::TREBLE);
                if first || clef[p] != Some(c) {
                    at.clef = Some(c);
                }
                clef[p] = Some(c);
                let kk = if a.clef.is_some_and(|c| c.sign == dolce_omr_sheet::music::ClefSign::Percussion) { Key::default() } else { sys_key };
                if first || key[p] != Some(kk) {
                    at.key = Some(kk);
                }
                key[p] = Some(kk);
                // 拍号：曲首照读数；后面的系统只收「与现行不同、且同系统两行以上各自读出同一个」的（单行系统只收数字拍号）
                if let Some(t) = a.time {
                    let strong = a.time_votes >= 2 || (rows.len() == 1 && t.symbol == dolce_omr_sheet::music::TimeSymbol::Normal);
                    if first || (time != Some(t) && strong) {
                        at.time = Some(t);
                    }
                }
                ms[0].attrs = at;
                // 行中切换：落在哪个小节；最后一条小节线之后的（行末预告）不属于这一行
                for ch in &a.changes {
                    let j = bs.iter().filter(|b| b.x < ch.x).count();
                    if j >= count {
                        continue;
                    }
                    if let Some(c) = ch.attrs.clef {
                        clef[p] = Some(c);
                    }
                    if let Some(k) = ch.attrs.key {
                        key[p] = Some(k);
                    }
                    if j > 0 && ms[j].attrs.is_empty() && ch.x - bs[j - 1].x < f.unit.space * 4.0 {
                        ms[j].attrs = ch.attrs;
                    } else {
                        ms[j].mid.push(ch.attrs);
                    }
                }
                ms[0].new_system = true;
                ms[0].new_page = si == 0 && pn > 0;
                ms[0].implicit = implicit;
                parts[p].measures.extend(ms);
                layout.push(RowLayout { row: row_no, part: p, from, to: from + count - 1, space: f.staves[i].space() });
                row_no += 1;
            }
            // 这一系统没印的声部照样占这么多小节
            for (p, part) in parts.iter_mut().enumerate() {
                if !used[p] {
                    let mut ms: Vec<Measure> = (0..count).map(|_| Measure::default()).collect();
                    ms[0].new_system = true;
                    ms[0].new_page = si == 0 && pn > 0;
                    ms[0].implicit = implicit;
                    part.measures.extend(ms);
                }
            }
            if let Some(t) = rows.iter().filter_map(|&i| page.attrs[i].time).next() {
                let votes = rows.iter().map(|&i| page.attrs[i].time_votes).max().unwrap_or(0);
                if from == 0 || votes >= 2 || (rows.len() == 1 && t.symbol == dolce_omr_sheet::music::TimeSymbol::Normal) {
                    time = Some(t);
                }
            }
            prev_open = open && !bs.is_empty();
            // 末小节的宽度折成「本行常见小节宽」的倍数，留给下一行比（各行线距、疏密不同，不直接比像素）
            prev_tail = if med > 0.0 { tail_w / med } else { 0.0 };
            let top = f.staves[rows[0]].top(f.staves[rows[0]].left) / f.up as f64;
            systems.push(SystemLayout { page: pn + 1, top, bars: count, rows: layout });
        }
    }
    Song { score: Score { title, parts }, systems }
}

impl Song {
    /// 版面摘要（判分脚本离线读的那份 JSON 文本）。
    pub fn layout_json(&self) -> String {
        let mut o = String::from("{\"version\":1,\"systems\":[");
        let mut sp = String::new();
        for (i, s) in self.systems.iter().enumerate() {
            if i > 0 {
                o.push(',');
            }
            o.push_str(&format!("{{\"page\":{},\"top\":{:.1},\"bars\":{},\"rows\":[", s.page, s.top, s.bars));
            for (k, r) in s.rows.iter().enumerate() {
                if k > 0 {
                    o.push(',');
                }
                o.push_str(&format!("{{\"row\":{},\"slot\":\"P{}.1\",\"part\":{},\"staff\":1,\"from\":{},\"to\":{},\"seqLen\":0}}", r.row, r.part + 1, r.part, r.from, r.to));
                if !sp.is_empty() {
                    sp.push(',');
                }
                sp.push_str(&format!("\"{}\":{:.2}", r.row, r.space));
            }
            o.push_str("]}");
        }
        o.push_str(&format!("],\"notes\":[],\"rowSp\":{{{sp}}}}}"));
        o
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fewer_rows_go_to_matching_clefs_bottom_first() {
        let (g, f) = (Some(Clef::TREBLE), Some(Clef::BASS));
        assert_eq!(assign(&[g, f], &[g, g, f, g, f]), vec![3, 4]);
        assert_eq!(assign(&[g, g, f], &[g, g, f, g, f]), vec![1, 3, 4]);
        assert_eq!(assign(&[g, f, g], &[g, f, g]), vec![0, 1, 2]);
    }
}

#[cfg(test)]
mod key_tests {
    use super::settle_keys;

    #[test]
    fn underread_rows_follow_neighbours() {
        // 孤零零一个系统少读
        assert_eq!(settle_keys(&[Some((-3, true)), Some((-2, true)), Some((-3, true))]), vec![-3, -3, -3]);
        // 开头两个系统收得不干净、少读一个
        assert_eq!(settle_keys(&[Some((-1, false)), Some((-1, false)), Some((-2, true))]), vec![-2, -2, -2]);
        // 真转调：前后各成一段、都收得干净
        assert_eq!(settle_keys(&[Some((-1, true)), Some((-1, true)), Some((2, true)), Some((2, true))]), vec![-1, -1, 2, 2]);
        // 没读出的沿用
        assert_eq!(settle_keys(&[None, Some((1, true)), None]), vec![1, 1, 1]);
    }
}
