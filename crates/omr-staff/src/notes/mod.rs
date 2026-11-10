//! 音符数据（M3）。现到 4c：实心头候选（[`heads`]）、空心头与全音符（[`hollow`]）→ 挂符干、同干成和弦（[`stems`]）；休止（[`rests`]）。
//! 音符时值只按头型（四分 / 二分 / 全），符杠符尾、临时记号与附点、裁决、满拍随后逐步加。
pub mod beams;
pub mod heads;
pub mod hollow;
pub mod rests;
pub mod stems;

use crate::attrs::RowAttrs;
use crate::page::PageFrame;
use heads::{Head, HeadKind, InkSum, Template, FILLED_HALF_W};
use dolce_omr_sheet::score::NoteType;
use serde::{Deserialize, Serialize};
use stems::Stem;

/// 同一根干：两个头找到的干的列相差不过这么多（相对线距）、纵向连着。
const SAME_STEM: f64 = 0.25;
/// 模板分比本页挂干种子的中位数低这么多的种子丢掉。
const TPL_DROP: f64 = 0.2;
/// 符杠端头当成的假头：离干端不到 `BEAM_END`、所在行横向墨宽过 `BEAM_WIDE`（相对线距）。
const BEAM_END: f64 = 0.6;
const BEAM_WIDE: f64 = 1.6;
/// 两个和弦的头横向相隔不到这么多（相对线距）的算同一拍点（上下两个声部各自带干）。
pub const SAME_ONSET: f64 = 0.8;

impl Chord {
    /// 头型（同干的头按第一个算）。
    pub fn kind(&self) -> HeadKind {
        self.heads[0].kind
    }

    /// 时值的基本型：头型，实心头再按符杠 / 符尾数减半。
    pub fn ntype(&self) -> NoteType {
        match (self.kind(), self.tails) {
            (HeadKind::Whole, _) => NoteType::Whole,
            (HeadKind::Half, _) => NoteType::Half,
            (HeadKind::Filled, 0) => NoteType::Quarter,
            (HeadKind::Filled, 1) => NoteType::Eighth,
            (HeadKind::Filled, 2) => NoteType::N16th,
            (HeadKind::Filled, _) => NoteType::N32nd,
        }
    }
}

/// 一个和弦（同一根干上的头；单音也是）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Chord {
    /// 各头中心 x 的平均。
    pub x: f64,
    /// 自上而下。
    pub heads: Vec<Head>,
    /// 全音符没有干。
    pub stem: Option<Stem>,
    /// 符杠层数或符尾条数（[`beams`]）。
    pub tails: u8,
    /// `tails` 数的是符杠（否则是符尾）。
    pub beamed: bool,
}

/// 一行谱的音符（按 x 排）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RowNotes {
    pub chords: Vec<Chord>,
    /// 休止（按 x 排）。
    pub rests: Vec<rests::Rest>,
}

/// 一页各行谱的音符（与 `staves` 同序）。
pub fn page_notes(f: &PageFrame, attrs: &[RowAttrs]) -> Vec<RowNotes> {
    let sum = InkSum::new(&f.ink);
    let from_of = |si: usize| attrs.get(si).map_or(f.staves[si].left, |a| a.lead_end.max(f.staves[si].left));
    // 实心头：各行的种子与各自的干
    let mut cands: Vec<(Head, Stem)> = Vec::new();
    for si in 0..f.staves.len() {
        let sp = f.staves[si].space();
        for h in heads::seeds(f, &sum, si, from_of(si)) {
            if !heads::ledger_ok(f, &h, FILLED_HALF_W * sp) {
                continue;
            }
            if let Some(st) = stems::find_stem(&f.ink, &h, sp, f.unit.thick, None) {
                cands.push((h, st));
            }
        }
    }
    // 模板：挂得上干的种子叠出来；逐个打分，比本页中位数差得多的丢掉
    let samples: Vec<(f64, f64, f64)> = cands.iter().map(|(h, _)| (h.x, h.y, f.staves[h.staff].space())).collect();
    let tpl = Template::bootstrap(&f.ink, &samples).unwrap_or_else(Template::synthetic);
    for (h, _) in cands.iter_mut() {
        let (s, x, y) = tpl.best_score(&f.ink, h.x, h.y, f.staves[h.staff].space(), 1);
        (h.score, h.x, h.y) = (s, x, y);
    }
    let scores: Vec<f64> = cands.iter().map(|(h, _)| h.score).collect();
    let floor = dolce_omr_core::geom::median(&scores, 0.0) - TPL_DROP;
    cands.retain(|(h, _)| h.score >= floor);
    let mut all: Vec<(Head, Option<Stem>)> = cands.into_iter().map(|(h, s)| (h, Some(s))).collect();
    // 空心头与全音符
    let holes = hollow::page_holes(f);
    for si in 0..f.staves.len() {
        all.extend(hollow::hollow_heads(f, &holes, si, from_of(si)));
    }

    let mut rows: Vec<RowNotes> = (0..f.staves.len()).map(|_| RowNotes::default()).collect();
    for (h, st) in all {
        let sp = f.staves[h.staff].space();
        let row = &mut rows[h.staff];
        let hit = st.and_then(|st| row.chords.iter_mut().find(|c| c.stem.is_some_and(|cs| (cs.x - st.x).abs() as f64 <= SAME_STEM * sp && cs.top <= st.bottom && st.top <= cs.bottom)));
        match (hit, st) {
            (Some(c), Some(st)) => {
                let cs = c.stem.as_mut().unwrap();
                cs.top = cs.top.min(st.top);
                cs.bottom = cs.bottom.max(st.bottom);
                c.heads.push(h);
            }
            _ => row.chords.push(Chord { x: h.x, heads: vec![h], stem: st, tails: 0, beamed: false }),
        }
    }
    for row in rows.iter_mut() {
        for c in row.chords.iter_mut() {
            c.heads.sort_by(|a, b| a.pos.cmp(&b.pos).then(a.x.total_cmp(&b.x)));
            c.heads.dedup_by(|a, b| a.pos == b.pos && (a.x - b.x).abs() < 1.0);
            c.x = c.heads.iter().map(|h| h.x).sum::<f64>() / c.heads.len() as f64;
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
        row.chords.sort_by(|a, b| a.x.total_cmp(&b.x));
    }
    beams::tails(&f.ink, &mut rows, &f.staves, f.unit.thick);
    for (si, row) in rows.iter_mut().enumerate() {
        row.rests = rests::rests(f, si, from_of(si));
    }
    rows
}
