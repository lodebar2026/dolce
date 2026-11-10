//! 音符数据（M3）。现到 4c：实心头候选（[`heads`]）、空心头与全音符（[`hollow`]）→ 挂符干、同干成和弦（[`stems`]）；休止（[`rests`]）。
//! 音符时值只按头型（四分 / 二分 / 全），符杠符尾、临时记号与附点、裁决、满拍随后逐步加。
pub mod heads;
pub mod hollow;
pub mod rests;
pub mod stems;

use crate::attrs::RowAttrs;
use crate::page::PageFrame;
use heads::{Head, HeadKind, InkSum, Template, FILLED_HALF_W};
use serde::{Deserialize, Serialize};
use stems::Stem;

/// 同一根干：两个头找到的干的列相差不过这么多（相对线距）、纵向连着。
const SAME_STEM: f64 = 0.25;
/// 模板分比本页挂干种子的中位数低这么多的种子丢掉。
const TPL_DROP: f64 = 0.2;
/// 两个和弦的头横向相隔不到这么多（相对线距）的算同一拍点（上下两个声部各自带干）。
pub const SAME_ONSET: f64 = 0.8;

impl Chord {
    /// 头型（同干的头按第一个算）。
    pub fn kind(&self) -> HeadKind {
        self.heads[0].kind
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
            _ => row.chords.push(Chord { x: h.x, heads: vec![h], stem: st }),
        }
    }
    for row in rows.iter_mut() {
        for c in row.chords.iter_mut() {
            c.heads.sort_by(|a, b| a.pos.cmp(&b.pos).then(a.x.total_cmp(&b.x)));
            c.heads.dedup_by(|a, b| a.pos == b.pos && (a.x - b.x).abs() < 1.0);
            c.x = c.heads.iter().map(|h| h.x).sum::<f64>() / c.heads.len() as f64;
        }
        row.chords.sort_by(|a, b| a.x.total_cmp(&b.x));
    }
    for (si, row) in rows.iter_mut().enumerate() {
        row.rests = rests::rests(f, si, from_of(si));
    }
    rows
}
