//! **裁决**（3.6）：各路候选（实心种子、孔里找出的空心头与全音符）在这里按归属与互斥一次取舍，再成和弦。
//!
//! - 归属（[`Claims`]）：框架层定下的小节线占着的竖笔，不再当符干。
//! - 互斥：争同一处墨的相邻音级候选，按模板分取总分最高的一组互不相争的（[`pick`]）；同一根干上的假头（[`chord_rules`]）。
use super::heads::{same_ink, Head, HeadKind};
use super::stems;
use super::Chord;
use crate::page::PageFrame;

/// 符杠端头当成的假头：离干端不到 `BEAM_END`、所在行横向墨宽过 `BEAM_WIDE`（相对线距）。
const BEAM_END: f64 = 0.6;
const BEAM_WIDE: f64 = 1.6;

/// 已经归了框架层的墨：各行谱定下的小节线（不带存疑标记、由本行竖段认出的）占的列。
pub struct Claims {
    bars: Vec<Vec<(i64, i64)>>,
}

impl Claims {
    pub fn new(f: &PageFrame) -> Self {
        let bars = f.bars.iter().map(|row| row.iter().filter(|b| !b.weak && !b.segs.is_empty()).flat_map(|b| b.segs.iter().map(|s| (s.x0 as i64 - 1, s.x1 as i64 + 1))).collect()).collect();
        Claims { bars }
    }

    /// 第 `si` 行谱的 `x` 列是定下的小节线的一笔。
    pub fn bar_col(&self, si: usize, x: i64) -> bool {
        self.bars.get(si).is_some_and(|r| r.iter().any(|&(a, b)| a <= x && x <= b))
    }
}

/// 争同一处墨的候选里取一组互不相争、总分最高的。`w[i]`：候选 i 的分（越大越可信，须为正）。回留下的下标。
///
/// 上下叠着的三度两个头（中间夹一条加线或谱线）连成一柱墨，正中那个音级上种子框也撑得满；
/// 只按「谁最满留谁」会把两个头并成中间那一个。两头的两个候选互不相争，合起来的分比中间一个高。
pub fn pick(heads: &[Head], w: &[f64], sp_of: &dyn Fn(usize) -> f64) -> Vec<usize> {
    let n = heads.len();
    let mut comp: Vec<usize> = (0..n).collect();
    fn root(c: &mut [usize], mut i: usize) -> usize {
        while c[i] != i {
            c[i] = c[c[i]];
            i = c[i];
        }
        i
    }
    let clash = |i: usize, j: usize| same_ink(&heads[i], &heads[j], sp_of(heads[i].staff));
    // 候选按 x 排好的话只用比邻近的；这里不假定次序，量不大，直接两两比
    for i in 0..n {
        for j in i + 1..n {
            if clash(i, j) {
                let (a, b) = (root(&mut comp, i), root(&mut comp, j));
                comp[a] = b;
            }
        }
    }
    let mut groups: std::collections::BTreeMap<usize, Vec<usize>> = Default::default();
    for i in 0..n {
        groups.entry(root(&mut comp, i)).or_default().push(i);
    }
    let mut keep = Vec::new();
    for g in groups.into_values() {
        if g.len() == 1 {
            keep.push(g[0]);
            continue;
        }
        // 组不大（一柱叠着的头）：逐个取或不取搜一遍；太大的退回贪心
        if g.len() > 16 {
            let mut order = g.clone();
            order.sort_by(|&a, &b| w[b].total_cmp(&w[a]));
            let mut got: Vec<usize> = Vec::new();
            for i in order {
                if !got.iter().any(|&j| clash(i, j)) {
                    got.push(i);
                }
            }
            keep.extend(got);
            continue;
        }
        let mut best = (f64::MIN, 0u32);
        for mask in 1u32..(1 << g.len()) {
            let on: Vec<usize> = (0..g.len()).filter(|&k| mask >> k & 1 == 1).map(|k| g[k]).collect();
            if on.iter().enumerate().any(|(a, &i)| on[a + 1..].iter().any(|&j| clash(i, j))) {
                continue;
            }
            let sum: f64 = on.iter().map(|&i| w[i]).sum();
            if sum > best.0 {
                best = (sum, mask);
            }
        }
        keep.extend((0..g.len()).filter(|&k| best.1 >> k & 1 == 1).map(|k| g[k]));
    }
    keep.sort_unstable();
    keep
}

/// 同一根干上的假头。
pub fn chord_rules(f: &PageFrame, c: &mut Chord) {
    // 干的两端各贴着一个「头」：真和弦的干总要伸出最外面的头一截，贴着干端的那个是符杠的端头（杠够厚时撑得满种子框）
    // 或两层杠之间的白缝，它上下两行横向都连着一长条墨
    if let (Some(st), true) = (c.stem, c.heads.len() >= 2) {
        let sp = f.staves[c.heads[0].staff].space();
        let (near, wide) = (BEAM_END * sp, (BEAM_WIDE * sp) as i64);
        // 实心的量头里的两行；「空心」的（两层杠与两根干围出的白缝被当成孔）量孔外上下两层杠所在的行
        let is_bar = |h: &Head| {
            let off = ((if h.kind == HeadKind::Filled { 0.2 } else { 0.35 }) * sp).round() as i64;
            [-off, off].iter().any(|d| (-1..=1).any(|dx| stems::width_at(&f.ink, h.x.round() as i64 + dx * (sp * 0.3) as i64, h.y.round() as i64 + d, wide) > wide))
        };
        let (top, bot) = (c.heads[0].clone(), c.heads.last().unwrap().clone());
        if (top.y - st.top as f64).abs() < near && (bot.y - st.bottom as f64).abs() < near {
            if is_bar(&top) {
                c.heads.remove(0);
            } else if is_bar(&bot) {
                c.heads.pop();
            } else if top.kind == HeadKind::Filled && bot.kind == HeadKind::Filled {
                // 斜杠在每一行上只有短短一截，量不出长条：两个里模板分低的那个是杠端
                if top.score < bot.score {
                    c.heads.remove(0);
                } else {
                    c.heads.pop();
                }
            }
        }
    }
    // 一根干上实心、空心混着：干是从最贴着干端的那个头起的，它是真的；头型与它不同的丢掉
    // （符尾与干、谱线围出的白被当成孔，在同一根干上添一个「空心头」）
    if let (Some(st), true) = (c.stem, c.heads.len() >= 2) {
        let end_dist = |h: &Head| (h.y - st.top as f64).abs().min((h.y - st.bottom as f64).abs());
        let base = c.heads.iter().min_by(|a, b| end_dist(a).total_cmp(&end_dist(b))).unwrap().kind;
        c.heads.retain(|h| h.kind == base);
    }
    // 干的朝向按整个和弦定：自由端是离头远的那一端（单看一个头时，和弦里两个头之间那截细干会被当成伸出去的一段）
    if let Some(st) = c.stem.as_mut() {
        let (hi, lo) = (c.heads.first().unwrap().y, c.heads.last().unwrap().y);
        st.up = hi - st.top as f64 >= st.bottom as f64 - lo;
    }
}
