//! 音符数据（M3）。现到 4g：实心头候选（[`heads`]）、空心头与全音符（[`hollow`]）、加线作证（[`ledgers`]）→ 挂符干（[`stems`]）
//! → 裁决（[`resolve`]：归属、争同一处墨的候选取舍、同干假头）→ 成和弦；休止（[`rests`]）、符杠符尾（[`beams`]）、临时记号与附点（[`marks`]）。
//! 满拍裁决（[`meter`]）要小节与拍号，在整曲拼接时逐系统做（[`crate::song`]）。
pub mod artics;
pub mod beams;
pub mod heads;
pub mod hollow;
pub mod ledgers;
pub mod marks;
pub mod meter;
pub mod resolve;
pub mod rests;
pub mod stems;
pub mod tuplets;

use crate::attrs::RowAttrs;
use crate::frame::ink::{Blob, LINE};
use crate::page::PageFrame;
use heads::{Head, HeadKind, InkSum, Template};
use ledgers::FILLED_HALF_W;
use resolve::Claims;
use dolce_omr_sheet::score::NoteType;
use serde::{Deserialize, Serialize};
use stems::Stem;

/// 同一根干：两个头找到的干的列相差不过这么多（相对线距）、纵向连着。
const SAME_STEM: f64 = 0.25;
/// 模板分比本页挂干种子的中位数低这么多的种子丢掉。
const TPL_DROP: f64 = 0.2;
/// 两个和弦的头横向相隔不到这么多（相对线距）的算同一拍点（上下两个声部各自带干）。
pub const SAME_ONSET: f64 = 0.8;
/// 常见字体的实心头宽（相对线距，按模板过中心那一行量）。
const HEAD_W: f64 = 1.25;

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
    /// 附点数。
    pub dots: u8,
    /// 贴头奏法（[`artics`]）。
    #[serde(default)]
    pub arts: Vec<dolce_omr_sheet::score::Art>,
    /// 连音（满拍裁决收下的候选，[`tuplets`]）。
    #[serde(default)]
    pub tuplet: Option<dolce_omr_sheet::score::Tuplet>,
}

/// 一行谱的音符（按 x 排）。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct RowNotes {
    pub chords: Vec<Chord>,
    /// 休止（按 x 排）。
    pub rests: Vec<rests::Rest>,
    /// 连音候选（[`tuplets`]）；满拍裁决收下的记到和弦上。
    #[serde(default)]
    pub tuplets: Vec<tuplets::TupletCand>,
}

/// 与墨块 `b` 隔着细缝的别的墨块：同一行里一小截存疑像素（不长过 `slit`）两边分别是 `b` 与另一块的墨。
/// 符号里两笔之间的细缝正落在线带上时，缝里只有谱线那几行有墨、纵向墨段短，会被当成线，一个符号断成两块（八分休止的圆点与斜笔）。
pub(crate) fn bridged(f: &PageFrame, b: &Blob, slit: usize) -> Vec<i32> {
    let pw = f.ink.w;
    let (x0, y0, w, h) = (b.rect.x as usize, b.rect.y as usize, b.rect.w as usize, b.rect.h as usize);
    let me = b.id as i32;
    let mut out: Vec<i32> = Vec::new();
    for y in y0..y0 + h {
        for x in x0..x0 + w {
            if f.labels[y * pw + x] != me {
                continue;
            }
            // 向左、向右各看一截
            for dir in [-1i64, 1] {
                let mut n = 0;
                let mut xx = x as i64 + dir;
                while xx >= 0 && (xx as usize) < pw && n < slit && f.ink.tri[y * pw + xx as usize] == LINE {
                    xx += dir;
                    n += 1;
                }
                if n == 0 || xx < 0 || xx as usize >= pw {
                    continue;
                }
                let other = f.labels[y * pw + xx as usize];
                if other != 0 && other != me && !out.contains(&other) {
                    out.push(other);
                }
            }
        }
    }
    out
}

/// 实心头的前半段：封过口的墨层、各行挂得上干的种子、自举模板的样本与模板。
struct SeedStage {
    solid: crate::frame::ink::InkLayers,
    cands: Vec<(Head, Stem)>,
    samples: Vec<(f64, f64, f64)>,
    tpl: Template,
}

fn x_from(f: &PageFrame, attrs: &[RowAttrs], si: usize) -> f64 {
    attrs.get(si).map_or(f.staves[si].left, |a| a.lead_end.max(f.staves[si].left))
}

fn seed_stage(f: &PageFrame, attrs: &[RowAttrs], claims: &Claims) -> SeedStage {
    // 实心头在封过口的墨层上找：扫描件的头里常夹着几像素的白缝，种子框、模板都按「满不满」量
    let solid = f.ink.sealed((hollow::SLIT_AREA * f.unit.space * f.unit.space).round() as usize);
    let sum = InkSum::new(&solid);
    // 各行的种子（谱表外的要加线作证）与各自的干
    let mut cands: Vec<(Head, Stem)> = Vec::new();
    // 自举模板的样本：争同一处墨的种子里最满的那个
    let mut samples: Vec<(f64, f64, f64)> = Vec::new();
    for si in 0..f.staves.len() {
        let sp = f.staves[si].space();
        let row: Vec<(Head, Stem)> = heads::seeds(f, &solid, &sum, si, x_from(f, attrs, si))
            .into_iter()
            .filter(|h| ledgers::ledger_ok(f, h, FILLED_HALF_W * sp))
            .filter_map(|h| stems::find_stem(&f.ink, &h, sp, f.unit.thick, None, &|x| claims.bar_col(si, x)).map(|st| (h, st)))
            .collect();
        samples.extend(heads::fullest(row.iter().map(|(h, _)| h.clone()).collect(), sp).iter().map(|h| (h.x, h.y, sp)));
        cands.extend(row);
    }
    // 模板：挂得上干的种子叠出来
    let tpl = Template::bootstrap(&solid, &samples).unwrap_or_else(Template::synthetic);
    SeedStage { solid, cands, samples, tpl }
}

/// 本页符头比常见的大多少（不小于 1）：实心头模板量出的头宽比 [`HEAD_W`]。空心头的孔、外圈的尺寸上限照它放大。
pub fn head_scale(f: &PageFrame, attrs: &[RowAttrs]) -> f64 {
    scale_of(&seed_stage(f, attrs, &Claims::new(f)).tpl)
}

fn scale_of(tpl: &Template) -> f64 {
    (tpl.head_width() / HEAD_W).max(1.0)
}

/// 一页各行谱的音符（与 `staves` 同序）。
pub fn page_notes(f: &PageFrame, attrs: &[RowAttrs], ocr: Option<&dyn crate::attrs::DigitReader>) -> Vec<RowNotes> {
    let claims = Claims::new(f);
    let from_of = |si: usize| x_from(f, attrs, si);
    let SeedStage { solid, mut cands, samples, tpl } = seed_stage(f, attrs, &claims);
    // 逐个打分，比本页中位数差得多的丢掉
    for (h, _) in cands.iter_mut() {
        let (s, x, y) = tpl.best_score(&solid, h.x, h.y, f.staves[h.staff].space(), 1);
        (h.score, h.x, h.y) = (s, x, y);
    }
    let sample_scores: Vec<f64> = samples.iter().map(|&(x, y, sp)| tpl.best_score(&solid, x, y, sp, 1).0).collect();
    let floor = dolce_omr_core::geom::median(&sample_scores, 0.0) - TPL_DROP;
    cands.retain(|(h, _)| h.score >= floor);
    // 争同一处墨的相邻音级候选：取总分最高的一组（分 = 模板分高出门槛多少）
    let hs: Vec<Head> = cands.iter().map(|(h, _)| h.clone()).collect();
    let w: Vec<f64> = hs.iter().map(|h| h.score - floor + 0.01).collect();
    let keep = resolve::pick(&hs, &w, &|si| f.staves[si].space());
    let mut all: Vec<(Head, Option<Stem>)> = keep.into_iter().map(|i| (cands[i].0.clone(), Some(cands[i].1))).collect();
    // 空心头与全音符
    let holes = hollow::page_holes(f);
    for si in 0..f.staves.len() {
        all.extend(hollow::hollow_heads(f, &holes, &claims, si, from_of(si), scale_of(&tpl)));
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
            _ => row.chords.push(Chord { x: h.x, heads: vec![h], stem: st, tails: 0, beamed: false, dots: 0, arts: Vec::new(), tuplet: None }),
        }
    }
    for row in rows.iter_mut() {
        for c in row.chords.iter_mut() {
            c.heads.sort_by(|a, b| a.pos.cmp(&b.pos).then(a.x.total_cmp(&b.x)));
            c.heads.dedup_by(|a, b| a.pos == b.pos && (a.x - b.x).abs() < 1.0);
            c.x = c.heads.iter().map(|h| h.x).sum::<f64>() / c.heads.len() as f64;
            resolve::chord_rules(f, c);
        }
        row.chords.sort_by(|a, b| a.x.total_cmp(&b.x));
    }
    for (si, row) in rows.iter_mut().enumerate() {
        row.rests = rests::rests(f, si, from_of(si));
    }
    beams::tails(&f.ink, &mut rows, &f.staves, f.unit.thick);
    for (si, row) in rows.iter_mut().enumerate() {
        marks::marks(f, si, from_of(si), row);
    }
    artics::artics(f, &mut rows);
    tuplets::tuplets(f, &mut rows, ocr);
    rows
}
