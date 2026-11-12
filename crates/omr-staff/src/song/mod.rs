//! 整曲（M7）：各页的系统按次序接成声部与小节，谱号 / 调号 / 拍号跨行跨页沿用，交出结果模型与版面摘要。
//!
//! 现在的声部指派很简单：行数最多的系统定声部数，一行谱一个声部；行数少的系统按谱号保序配到声部上（并列时靠下——
//! 少印的多半是上面的人声行，伴奏在最下）。花括号合大谱表、按歌词 / 音域 / 标签指派留到整曲定稿那一期。
use crate::attrs::RowAttrs;
use crate::mixed::fuse;
use crate::frame::bars::BarStyle;
use crate::page::Page;
use dolce_omr_sheet::music::{Clef, Key};
use crate::notes::meter::{self, Bar, Stats};
use crate::notes::rests::Rest;
use crate::notes::{Chord, RowNotes, SAME_ONSET};
use dolce_omr_sheet::meter::{timeline, SHARED};
use crate::text::classify::RowText;
use crate::spans::arcs::{Arc, ChordRef};
use crate::spans::wedges::Wedge;
use dolce_omr_sheet::music::Pitch;
use dolce_omr_sheet::result::{codes, Doubt, Locus, Rid, RidKind, RidSeq, Src, SrcBox};
use dolce_omr_core::image::Rect;
use dolce_omr_sheet::score::{self, measure_divisions, Attrs, Dir, HeadSrc, Placed, Ending, Event, Lyric, Measure, Part, Score, SpanKind, SpanMark};
use dolce_omr_text::lyrics::align;
use serde::Serialize;

mod assign;
mod attach;
mod constraints;
mod grand;
mod ids;
mod review;
mod spans;
pub use constraints::{Constraints, Context, Fact};
use constraints::apply_pins;
use assign::*;
use attach::*;
use grand::*;
use ids::*;
use spans::*;

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
    /// 这一行的拍点数（和弦算一个）。
    pub seq_len: usize,
}

pub struct SystemLayout {
    pub page: usize,
    pub top: f64,
    pub bars: usize,
    pub rows: Vec<RowLayout>,
    /// 这个系统各行谱的页内下标（自上而下；核对几何按它引用 [`PageGeom::staves`]）。
    pub staves: Vec<usize>,
}

/// 核对几何（编辑器对照视图、点谱行菜单用）：一页的各行谱，坐标是原图像素。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageGeom {
    /// 1 起。
    pub pn: usize,
    pub staves: Vec<StaffGeom>,
    /// 认出的简谱带个数（有就是混排谱）。
    pub jianpu: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaffGeom {
    /// 五条线的 y（谱行横向中点处量）。
    pub line_ys: Vec<f64>,
    /// 各小节：右线 x、小节里各音的框。
    pub bars: Vec<BarGeom>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct BarGeom {
    pub right: f64,
    pub notes: Vec<NoteGeom>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct NoteGeom {
    #[serde(rename = "box")]
    pub bx: BoxLrtb,
}

/// 核对几何的坐标取到 0.01 像素：OCR 现推与读缓存的字框差在末几位，取整后同一份底本的核对 JSON 逐字相同。
pub fn px(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

/// TS 那边的框形状（`left / right / top / bottom`）。
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct BoxLrtb {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

impl From<Rect> for BoxLrtb {
    fn from(r: Rect) -> Self {
        BoxLrtb { left: px(r.x), right: px(r.right()), top: px(r.y), bottom: px(r.bottom()) }
    }
}

pub struct Song {
    pub score: Score,
    pub systems: Vec<SystemLayout>,
    /// 各页的核对几何（与输入的页同序）。
    pub pages: Vec<PageGeom>,
    /// 各槽位（`RowLayout::part`）落到（第几声部, 第几谱表）：大谱表合并后两个槽位进同一个声部。
    pub slot_at: Vec<(usize, u8)>,
    /// 关联表：各系统各行配到了第几个槽位（编辑器关联表的初值；改了交回 [`Constraints::slots`]）。
    pub assignment: Vec<Vec<usize>>,
    /// 可疑清单（满拍裁决交来的；别的模块的随后并进来）。
    pub doubts: Vec<Doubt>,
    /// 满拍读数。
    pub meter: Stats,
    /// 混排谱简谱互证的读数。
    pub fused: fuse::Stats,
    /// 框架与音符取自矢量层（判分按矢量档分）。
    pub vector: bool,
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
    let f = &page.layout;
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

/// 本页实心头模板分的中位数（满拍裁决掂量「删这个头」时比的尺子）。
fn page_med(page: &Page) -> f64 {
    let v: Vec<f64> = page.notes.iter().flat_map(|r| r.chords.iter()).flat_map(|c| c.heads.iter()).filter(|h| h.kind == crate::notes::heads::HeadKind::Filled).map(|h| h.score).collect();
    dolce_omr_core::geom::median(&v, 0.0)
}

/// 房子的横线右端离谱表右端不过这么多（相对线距）、又没有收口的钩，算画到行尾（下一行接着）。
const VOLTA_TO_END: f64 = 2.5;

/// 弱起与跨行劈开的小节按拍数定（各声部的小节结构相同，按全部声部量）：
/// 曲首小节不满拍、又是整拍的是弱起；系统首小节与上一系统末小节都不满、合起来正好一小节的是跨行劈开的后半截；
/// 按宽度估成劈开、两半其实各自满拍的撤掉。都记 `implicit`。
fn split_bars(parts: &mut [Part]) {
    let n = parts.iter().map(|p| p.measures.len()).max().unwrap_or(0);
    // 第 mi 小节的内容时值（各声部里最长的；全空为 0）与现行拍号的一小节
    let dur = |mi: usize| parts.iter().filter_map(|p| p.measures.get(mi)).flat_map(|m| m.events.iter()).map(|e| e.onset + e.divisions()).max().unwrap_or(0);
    let mut want = vec![0u32; n];
    let mut beat = vec![0u32; n];
    let mut now: Option<dolce_omr_sheet::music::Time> = None;
    for mi in 0..n {
        for p in parts.iter() {
            if let Some(m) = p.measures.get(mi) {
                if let Some(t) = std::iter::once(&m.attrs).chain(&m.mid).filter_map(|a| a.time).last() {
                    now = Some(t);
                }
            }
        }
        if let Some(t) = now {
            want[mi] = measure_divisions(t);
            beat[mi] = score::DIVISIONS * 4 / (t.beat_type as u32).max(1);
        }
    }
    let ds: Vec<u32> = (0..n).map(dur).collect();
    let firsts: Vec<bool> = (0..n).map(|mi| parts.iter().any(|p| p.measures.get(mi).is_some_and(|m| m.new_system))).collect();
    let mut set = |mi: usize, v: bool| parts.iter_mut().filter_map(|p| p.measures.get_mut(mi)).for_each(|m| m.implicit = v);
    if n > 1 && want[0] > 0 && ds[0] > 0 && ds[0] < want[0] && ds[0] % beat[0] == 0 {
        set(0, true);
    }
    for mi in 1..n {
        let w = want[mi];
        if !firsts[mi] || w == 0 || ds[mi] == 0 || ds[mi - 1] == 0 {
            continue;
        }
        if ds[mi] < w && ds[mi - 1] < w && ds[mi] + ds[mi - 1] == w {
            set(mi, true);
        } else if ds[mi] == w && ds[mi - 1] == w {
            set(mi, false);
        }
    }
}

/// 把各页（按次序）拼成整曲。
pub fn assemble(pages: &[Page], title: Option<String>) -> Song {
    assemble_with(pages, title, &Constraints::default())
}

/// 带约束拼整曲（[`Constraints`]：关联表、钉住的事实、从某处起改的谱号调号拍号）。只重跑拼接，不重认。
pub fn assemble_with(pages: &[Page], title: Option<String>, c: &Constraints) -> Song {
    let nparts = pages.iter().flat_map(|p| p.layout.systems.iter().map(|s| s.staves.len())).max().unwrap_or(0);
    let mut parts: Vec<Part> = (0..nparts).map(|_| Part::default()).collect();
    // 各声部现行的调号
    let mut key: Vec<Option<Key>> = vec![None; nparts];
    let mut systems = Vec::new();
    let mut row_no = 0;
    // 各系统的调号（同系统互证后各行相同，取第一个读出来的行）
    let sys_keys: Vec<Option<(i8, bool)>> = pages
        .iter()
        .flat_map(|p| p.layout.systems.iter().map(move |sys| sys.staves.iter().filter_map(|&i| p.attrs[i].key.map(|k| (k.fifths, p.attrs[i].key_sure))).next()))
        .collect();
    let mut keys = settle_keys(&sys_keys);
    for (n, k) in keys.iter_mut().enumerate() {
        if let Some(f) = c.key_at(n) {
            *k = f;
        }
    }
    // 各系统的行配到哪几个声部；各声部逐系统的行首谱号读数顺着乐曲定下来（行首换谱号少见：孤零零一行读得不同的照前后改）
    let mixed = pages.iter().any(|p| !p.layout.bands.is_empty());
    let profs = profiles(pages);
    // 关联表：给了且每个系统的行数都对得上就照它，否则自动指派
    let mut slots_all = match &c.slots {
        Some(s) if s.len() == profs.len() && s.iter().zip(&profs).all(|(a, b)| a.len() == b.len()) => s.clone(),
        _ => auto_slots(&profs),
    };
    let mut clef_reads: Vec<Vec<Option<(Clef, bool)>>> = vec![Vec::new(); nparts];
    let mut sys_no = 0;
    for page in pages {
        for sys in &page.layout.systems {
            let ra: Vec<&RowAttrs> = sys.staves.iter().map(|&i| &page.attrs[i]).collect();
            // 简线混排谱里只有一行谱表的系统就是旋律，一律归第一个声部（按特征配会落到靠下的声部，各行在两个声部间来回跳）
            if mixed && slots_all[sys_no].len() == 1 {
                slots_all[sys_no] = vec![0];
            }
            for r in clef_reads.iter_mut() {
                r.push(None);
            }
            for (k, &p) in slots_all[sys_no].iter().enumerate() {
                if let Some(c) = ra[k].clef {
                    *clef_reads[p].last_mut().unwrap() = Some((c, ra[k].clef_sure));
                }
            }
            sys_no += 1;
        }
    }
    let mut clefs: Vec<Vec<Option<Clef>>> = clef_reads.iter().map(|r| settle(r, |_, _| false)).collect();
    for (p, cs) in clefs.iter_mut().enumerate() {
        for (n, cl) in cs.iter_mut().enumerate() {
            if let Some(f) = c.clef_at(n, p) {
                *cl = Some(f);
            }
        }
    }
    // 混排谱：全曲的简谱校准（横向平移、「1」的位置）
    let lead_of = |page: &Page, i: usize| page.attrs[i].lead_end.max(page.layout.staves[i].left);
    let calib = {
        let mut rows: Vec<(fuse::Ctx, &RowNotes)> = Vec::new();
        let mut n = 0;
        for page in pages {
            for sys in &page.layout.systems {
                for (k, &i) in sys.staves.iter().enumerate() {
                    if let Some(jp) = page.layout.jianpu.iter().find(|r| r.staff == i) {
                        let c = clefs[slots_all[n][k]][n].unwrap_or(Clef::TREBLE);
                        rows.push((fuse::Ctx { si: i, st: &page.layout.staves[i], lead: lead_of(page, i), jp, clef: c, key: Key { fifths: keys[n] } }, &page.notes[i]));
                    }
                }
                n += 1;
            }
        }
        fuse::calibrate(&rows)
    };
    let mut fused = fuse::Stats::default();
    if std::env::var("OMR_MIXED_DEBUG").is_ok() {
        for (pn, page) in pages.iter().enumerate() {
            for b in &page.layout.bands {
                let n = page.layout.jianpu.iter().find(|r| r.staff == b.staff).map_or(0, |r| r.notes.len());
                eprintln!("页{} 简谱带 → 谱行{}（量自{}）y{:.0}~{:.0} 小节线{} 读出{}个音", pn + 1, b.staff, b.anchor, b.y0, b.y1, b.bars.len(), n);
            }
        }
        eprintln!("校准 {calib:?}");
    }
    let mut clef: Vec<Option<Clef>> = vec![None; nparts];
    let mut sys_no = 0;
    // 上一个系统行末没印右线（跨行劈开的小节）
    let mut prev_open = false;
    // 现行拍号
    let mut time: Option<dolce_omr_sheet::music::Time> = None;
    // 上一个系统末小节的宽度（相对它那一行常见的小节宽；没有为 0）
    let mut prev_tail = 0.0f64;
    let mut doubts: Vec<Doubt> = Vec::new();
    let mut stats = Stats::default();
    // 全曲汉字词最多几行（拉丁词的行号接在它后面）
    let han_lines = pages.iter().flat_map(|p| p.text.rows.iter()).flat_map(|r| r.lyrics.iter()).filter(|l| !l.latin).map(|l| l.number).max().unwrap_or(0);
    let total_sys: usize = pages.iter().map(|p| p.layout.systems.len()).sum();
    // 各声部的弧（两端定了的）与等下一个系统接的半条
    let mut span_recs: Vec<Vec<SpanRec>> = (0..nparts).map(|_| Vec::new()).collect();
    let mut pending: Vec<Vec<Pending>> = (0..nparts).map(|_| Vec::new()).collect();
    // 各声部画到行尾、还没收的房子
    let mut open_volta: Vec<Option<Ending>> = vec![None; nparts];
    // 各声部画到行尾、等下一个系统接着的松叶
    let mut open_wedge: Vec<OpenWedge> = vec![None; nparts];
    let mut geom: Vec<PageGeom> = pages
        .iter()
        .enumerate()
        .map(|(pn, p)| PageGeom {
            pn: pn + 1,
            jianpu: p.layout.bands.len(),
            staves: p
                .layout
                .staves
                .iter()
                .map(|s| {
                    let cx = (s.left + s.right) / 2.0;
                    StaffGeom { line_ys: (0..5).map(|k| px(s.y_of(cx, (k * 2) as f64) / p.layout.up)).collect(), bars: Vec::new() }
                })
                .collect(),
        })
        .collect();
    let mut ids = Ids::new(pages);
    apply_pins(pages, &mut ids.notes, &c.pins);
    for (pn, page) in pages.iter().enumerate() {
        let f = &page.layout;
        (ids.page, ids.up) = (pn + 1, f.up);
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
            // 满拍裁决：这个系统起头的拍号（本系统读到、够格的；否则沿用），行中换拍号的从那一小节起
            // 用户在这个系统改了拍号：当作读出、够格
            let forced = c.time_at(sys_i);
            let read = forced.or_else(|| rows.iter().filter_map(|&i| page.attrs[i].time).next());
            let votes = if forced.is_some() { 2 } else { rows.iter().map(|&i| page.attrs[i].time_votes).max().unwrap_or(0) };
            let mut now = read.filter(|t| from == 0 || votes >= 2 || (rows.len() == 1 && t.symbol == dolce_omr_sheet::music::TimeSymbol::Normal)).or(time);
            let bar_of = |x: f64| bs.iter().filter(|b| b.x < x).count().min(count - 1);
            let plain = |b: Option<&Bound>| b.is_none_or(|b| b.style == BarStyle::Regular && !b.rep_end && !b.rep_start);
            let bars: Vec<Bar> = (0..count)
                .map(|j| {
                    if let Some(t) = rows.iter().flat_map(|&i| page.attrs[i].changes.iter()).filter(|c| bar_of(c.x) == j).filter_map(|c| c.attrs.time).next() {
                        now = Some(t);
                    }
                    let edge = (j == 0 && (from == 0 || implicit)) || (j + 1 == count && (open || sys_no == total_sys));
                    let left = if j == 0 { None } else { bs.get(j - 1) };
                    Bar { want: now.map(measure_divisions), loose: edge || !plain(bs.get(j)) || !plain(left) }
                })
                .collect();
            let mut sys_notes: Vec<RowNotes> = rows.iter().map(|&i| ids.notes[pn][i].clone()).collect();
            // 混排谱：先照简谱行纠（音高、时值、补漏删假），再验满拍
            let xs: Vec<f64> = bs.iter().map(|b| b.x).collect();
            let wants: Vec<Option<u32>> = bars.iter().map(|b| b.want).collect();
            let loose: Vec<bool> = bars.iter().map(|b| b.loose).collect();
            for (k, &i) in rows.iter().enumerate() {
                if let Some(jp) = page.layout.jianpu.iter().find(|r| r.staff == i) {
                    let c = clefs[slots[k]][sys_i].unwrap_or(Clef::TREBLE);
                    let cx = fuse::Ctx { si: i, st: &f.staves[i], lead: lead_of(page, i), jp, clef: c, key: sys_key };
                    fused += fuse::apply(&cx, &mut sys_notes[k], &xs, &wants, &loose, &calib);
                }
            }
            let head_med = page_med(page);
            let (flags, st) = meter::settle_system(f, rows, &mut sys_notes, &bar_of, &bars, head_med);
            stats += st;
            // 多小节休止：第 j 小节印着 n 小节的，各声部在它后面插 n − 1 个整小节休止（GT 照展开后的小节记）
            let mut extra: Vec<(usize, usize)> = Vec::new();
            for r in sys_notes.iter().flat_map(|rn| rn.rests.iter()).filter(|r| r.measures >= 2) {
                let j = bar_of(r.x);
                match extra.iter_mut().find(|e| e.0 == j) {
                    Some(e) => e.1 = e.1.max(r.measures as usize - 1),
                    None => extra.push((j, r.measures as usize - 1)),
                }
            }
            extra.sort_unstable();
            let added: usize = extra.iter().map(|e| e.1).sum();
            // 原第 j 小节（系统内）展开后的下标
            let shifted = |j: usize| j + extra.iter().filter(|e| e.0 < j).map(|e| e.1).sum::<usize>();
            for fl in flags {
                let s = &f.staves[rows[fl.row]];
                let x0 = if fl.bar == 0 { lead } else { bs[fl.bar - 1].x };
                let x1 = bs.get(fl.bar).map_or(s.right, |b| b.x);
                let up = f.up;
                let at = Locus { page: pn + 1, system: sys_i, row: fl.row, measure: Some(from + shifted(fl.bar)), note: None };
                doubts.push(Doubt::new(at, Rect::new(x0 / up, s.top(x0) / up, (x1 - x0) / up, (s.bottom(x0) - s.top(x0)) / up), fl.code).with_note(fl.note));
            }
            // 沿用来的调号、谱号（这个系统 / 这一行没读出来）
            let lead_rect = |k: usize| {
                let s = &f.staves[rows[k]];
                let x1 = page.attrs[rows[k]].lead_end.max(s.left + s.space());
                Rect::new(s.left / f.up, s.top(s.left) / f.up, (x1 - s.left) / f.up, (s.bottom(s.left) - s.top(s.left)) / f.up)
            };
            if sys_keys[sys_i].is_none() && sys_key.fifths != 0 {
                doubts.push(Doubt::new(Locus { page: pn + 1, system: sys_i, row: 0, measure: Some(from), note: None }, lead_rect(0), codes::KEY_CARRIED));
            }
            for (k, &p) in slots.iter().enumerate() {
                if clef_reads[p][sys_i].is_none() {
                    doubts.push(Doubt::new(Locus { page: pn + 1, system: sys_i, row: k, measure: Some(from), note: None }, lead_rect(k), codes::CLEF_CARRIED));
                }
            }
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
                if let Some(t) = forced.or(a.time) {
                    let strong = forced.is_some() || a.time_votes >= 2 || (rows.len() == 1 && t.symbol == dolce_omr_sheet::music::TimeSymbol::Normal);
                    if first || (time != Some(t) && strong) {
                        at.time = Some(t);
                    }
                }
                ms[0].attrs = at;
                // 音：按 x 落进小节；音高按那一处现行的谱号（行首的 + x 之前的行中切换）与调号。
                // 一行谱至多两个声部：各元素的起拍时刻与声部由本小节的时间线定（[`voices`]）
                let mut seq_len = 0;
                let notes = &sys_notes[k];
                let dx = SAME_ONSET * f.staves[i].space();
                // 和弦与休止按 x 合成一条序列
                let mut items: Vec<(f64, Option<&Chord>, Option<&Rest>)> = notes.chords.iter().map(|c| (c.x, Some(c), None)).chain(notes.rests.iter().map(|r| (r.x, None, Some(r)))).collect();
                items.sort_by(|a, b| a.0.total_cmp(&b.0));
                // 文字要挂的拍点：这一行各和弦的 (x, 小节, 事件)
                let mut anchors: Vec<Anchor> = Vec::new();
                // 松叶能挂的拍点：和弦与休止
                let mut beats: Vec<Anchor> = Vec::new();
                let mut n0 = 0;
                while n0 < items.len() {
                    let j = bar_of(items[n0].0);
                    let n1 = (n0..items.len()).find(|&n| bar_of(items[n].0) != j).unwrap_or(items.len());
                    let want = bars[j].want.unwrap_or(4 * dolce_omr_sheet::score::DIVISIONS);
                    let tl: Vec<(f64, f64, u32, Option<bool>)> = items[n0..n1]
                        .iter()
                        .map(|&(x, ch, rest)| match (ch, rest) {
                            (Some(c), _) => (x, c.heads.iter().map(|h| h.y).sum::<f64>() / c.heads.len() as f64, meter::chord_dur(c), c.stem.map(|s| s.up)),
                            (_, Some(r)) => (x, r.y, meter::rest_dur(r.ntype, r.dots, want), None),
                            _ => unreachable!(),
                        })
                        .collect();
                    let place = voices(&tl, dx);
                    // 临时记号在本小节内对同一音名同一八度一直有效
                    let mut held: std::collections::HashMap<(u8, i8), i8> = std::collections::HashMap::new();
                    for (&(_, ch, rest), &(onset, voice)) in items[n0..n1].iter().zip(&place) {
                        let Some(ch) = ch else {
                            let r = rest.unwrap();
                            let src = vec![HeadSrc { pitch: None, src: ids.src(r.rid, RidKind::Note, Rect::new(r.rect.0, r.rect.1, r.rect.2, r.rect.3)) }];
                            ms[j].events.push(Event { onset, voice, arts: r.arts.clone(), src, alts: meter::rest_menu(r), ..Event::new(vec![], r.ntype, r.dots, None) });
                            beats.push(Anchor { x: r.x, y: r.y, bar: j, event: ms[j].events.len() - 1, voice });
                            continue;
                        };
                        let (mut c_at, mut k_at) = (c, kk);
                        for x in a.changes.iter().filter(|x| x.x < ch.x) {
                            c_at = x.attrs.clef.unwrap_or(c_at);
                            k_at = x.attrs.key.unwrap_or(k_at);
                        }
                        let mut shown: Vec<(Pitch, i8)> = Vec::new();
                        let mut ps: Vec<_> = ch.heads.iter().map(|h| {
                            let mut p = c_at.pitch_at(h.pos);
                            p.alter = match h.acc {
                                Some(a) => {
                                    held.insert((p.step, p.octave), a);
                                    shown.push((Pitch { alter: a, ..p }, a));
                                    a
                                }
                                None => held.get(&(p.step, p.octave)).copied().unwrap_or(k_at.alter_of(p.step)),
                            };
                            p
                        }).collect();
                        let sp = f.staves[i].space();
                        let mut hs: Vec<HeadSrc> = ch.heads.iter().zip(&ps).map(|(h, p)| HeadSrc { pitch: Some(*p), src: ids.src(h.rid, RidKind::Note, head_rect(h.x, h.y, sp)) }).collect();
                        // 同一时刻同一声部已经有和弦的（并排两个朝向相同的干）并进去
                        let ei = match ms[j].events.iter().position(|e| e.onset == onset && e.voice == voice && !e.pitches.is_empty()) {
                            Some(n) => {
                                let e = &mut ms[j].events[n];
                                e.pitches.append(&mut ps);
                                e.src.append(&mut hs);
                                e.stem_up = None;
                                n
                            }
                            None => {
                                if meter::weak(ch, head_med) {
                                    let at = Locus { page: pn + 1, system: sys_i, row: k, measure: Some(from + shifted(j)), note: None };
                                    let h = &ch.heads[0];
                                    doubts.push(Doubt { rid: hs[0].src.rid, ..Doubt::new(at, ids.at(head_rect(h.x, h.y, sp)).rect, codes::HEAD_WEAK) });
                                }
                                ms[j].events.push(Event { onset, voice, tuplet: ch.tuplet, src: hs, alts: meter::chord_menu(ch, head_med), ..Event::new(ps, ch.ntype(), ch.dots, ch.stem.map(|s| s.up)) });
                                ms[j].events.len() - 1
                            }
                        };
                        anchors.push(Anchor { x: ch.x, y: ch.heads[0].y, bar: j, event: ei, voice });
                        let e = &mut ms[j].events[ei];
                        e.shown.extend(shown);
                        for a in &ch.arts {
                            if !e.arts.contains(a) {
                                e.arts.push(*a);
                            }
                        }
                        e.pitches.sort_by_key(|p| (p.octave, p.step));
                        e.pitches.dedup();
                    }
                    let mut ons: Vec<u32> = ms[j].events.iter().map(|e| e.onset).collect();
                    ons.sort_unstable();
                    ons.dedup();
                    seq_len += ons.len();
                    n0 = n1;
                }
                // 房子：记在印着它的这一行上，罩着哪几个小节。房号不读字：前一小节以反复结束线收尾的是第 2 房；
                // 罩着的最后一小节以反复结束线收尾的是第 1 房；都看不出、又印在行首的是第 2 房。
                // 横线画到行尾的先不收，下一个系统行首接着的那一条是它的续段（不另起）；下一个系统没有续段的，收在上一个系统的末小节
                let mut cont = open_volta[p].take();
                for v in page.spans.voltas.iter().filter(|v| v.staff == i) {
                    let sp = f.staves[i].space();
                    let js = bar_of(v.x0 + 1.5 * sp);
                    let je = bar_of(v.x1 - sp).max(js);
                    let e = match cont.take().filter(|_| js == 0) {
                        Some(e) => e,
                        None => {
                            let number = if js > 0 && bs[js - 1].rep_end {
                                2
                            } else if bs.get(je).is_some_and(|b| b.rep_end) {
                                1
                            } else if js == 0 {
                                2
                            } else {
                                1
                            };
                            let e = Ending { number, closed: v.closed };
                            ms[js].ending_start = Some(e);
                            e
                        }
                    };
                    if je + 1 == count && v.x1 >= f.staves[i].right - VOLTA_TO_END * sp && !v.closed {
                        open_volta[p] = Some(e);
                    } else {
                        ms[je].ending_stop = Some(Ending { closed: v.closed, ..e });
                    }
                }
                if let (Some(e), Some(last)) = (cont, parts[p].measures.last_mut()) {
                    last.ending_stop = Some(Ending { closed: false, ..e });
                }
                // 线性符号：弧、松叶按 x 挂到和弦上
                anchors.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.voice.cmp(&b.voice)));
                let sp_row = f.staves[i].space();
                let arcs: Vec<(usize, &Arc)> = page.spans.arcs.iter().enumerate().filter(|(_, a)| a.staff == i).collect();
                row_arcs(&arcs, &anchors, &ms, from, sp_row, sys_i, &mut pending[p], &mut span_recs[p], &mut ids);
                let wedges: Vec<&Wedge> = page.spans.wedges.iter().filter(|w| w.staff == i).collect();
                let rests: Vec<Anchor> = beats.clone();
                beats.extend(anchors.iter().copied());
                beats.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.voice.cmp(&b.voice)));
                row_wedges(&wedges, &beats, &mut ms, &bar_of, sp_row, (lead_of(page, i), f.staves[i].right), sys_i, &mut open_wedge[p], &mut parts[p].measures);
                attach_text(&mut ms, anchors, &rests, (i, &page.text.rows[i]), dx, han_lines, &mut ids);
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
                // 核对几何：印着的各小节（多小节休止展开之前）的右线与里面各音的框
                geom[pn].staves[i].bars = (0..count)
                    .map(|j| BarGeom {
                        right: px(bs.get(j).map_or(f.staves[i].right, |b| b.x) / f.up),
                        notes: ms[j].events.iter().flat_map(|e| e.src.iter()).filter_map(|h| h.src.at).map(|a| NoteGeom { bx: a.rect.into() }).collect(),
                    })
                    .collect();
                expand_multi_rests(&mut ms, &extra, from, &mut span_recs[p], &mut pending[p]);
                ms[0].new_system = true;
                ms[0].new_page = si == 0 && pn > 0;
                ms[0].implicit = implicit;
                parts[p].measures.extend(ms);
                layout.push(RowLayout { row: row_no, part: p, from, to: from + count + added - 1, space: f.staves[i].space(), seq_len });
                row_no += 1;
            }
            // 这一系统没印的声部照样占这么多小节
            for (p, part) in parts.iter_mut().enumerate() {
                if !used[p] {
                    let mut ms: Vec<Measure> = (0..count + added).map(|_| Measure::default()).collect();
                    // 混排谱里单行系统只印旋律，别的声部这几小节各记一个全休止，曲首就没印的照样交代谱号、调号、拍号。
                    // 别的谱不补：行数对不上多半是多认了假谱行，补出来的休止还得一个个删
                    for m in ms.iter_mut().filter(|_| mixed) {
                        m.events.push(Event::new(vec![], dolce_omr_sheet::score::NoteType::Whole, 0, None));
                    }
                    if mixed && from == 0 {
                        let c = clefs[p][sys_i].unwrap_or(Clef::TREBLE);
                        ms[0].attrs = Attrs { clef: Some(c), key: Some(sys_key), time: rows.iter().filter_map(|&i| page.attrs[i].time).next(), ..Attrs::default() };
                        (clef[p], key[p]) = (Some(c), Some(sys_key));
                    }
                    ms[0].new_system = true;
                    ms[0].new_page = si == 0 && pn > 0;
                    ms[0].implicit = implicit;
                    part.measures.extend(ms);
                }
            }
            if let Some(t) = read {
                if from == 0 || votes >= 2 || (rows.len() == 1 && t.symbol == dolce_omr_sheet::music::TimeSymbol::Normal) {
                    time = Some(t);
                }
            }
            prev_open = open && !bs.is_empty();
            // 末小节的宽度折成「本行常见小节宽」的倍数，留给下一行比（各行线距、疏密不同，不直接比像素）
            prev_tail = if med > 0.0 { tail_w / med } else { 0.0 };
            let top = f.staves[rows[0]].top(f.staves[rows[0]].left) / f.up;
            systems.push(SystemLayout { page: pn + 1, top, bars: count, rows: layout, staves: rows.clone() });
        }
    }
    for (part, recs) in parts.iter_mut().zip(span_recs) {
        mark_spans(part, recs);
    }
    split_bars(&mut parts);
    // 花括号括着的两个槽位合成大谱表
    let pairs = grand_pairs(pages, &slots_all, &profs, nparts);
    let (parts, slot_at) = merge(parts, &pairs);
    if std::env::var("OMR_MIXED_DEBUG").is_ok() {
        eprintln!("互证 {fused:?}");
    }
    let credits = pages.first().map(|p| p.text.credits.clone()).unwrap_or_default();
    let vector = pages.iter().any(|p| p.layout.vector);
    Song { score: Score { title, credits, parts }, systems, pages: geom, slot_at, assignment: slots_all, doubts, meter: stats, fused, vector }
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
                let (part, staff) = self.slot_at.get(r.part).copied().unwrap_or((r.part, 1));
                o.push_str(&format!("{{\"row\":{},\"slot\":\"P{}.{staff}\",\"part\":{part},\"staff\":{staff},\"from\":{},\"to\":{},\"seqLen\":{}}}", r.row, part + 1, r.from, r.to, r.seq_len));
                if !sp.is_empty() {
                    sp.push(',');
                }
                sp.push_str(&format!("\"{}\":{:.2}", r.row, r.space));
            }
            o.push_str("]}");
        }
        let ds: Vec<String> = self
            .doubts
            .iter()
            .map(|d| {
                let r = &d.rect;
                let top = self.systems.get(d.at.system).map_or(0.0, |s| s.top);
                format!("{{\"page\":{},\"sysTop\":{:.0},\"row\":{},\"m\":{},\"kind\":\"{}\",\"box\":[{:.0},{:.0},{:.0},{:.0}],\"note\":{:?}}}", d.at.page, top, d.at.row, d.at.measure.map_or(0, |m| m + 1), d.code, r.x, r.y, r.right(), r.bottom(), d.note)
            })
            .collect();
        let m = &self.meter;
        o.push_str(&format!("],\"vector\":{},\"notes\":[],\"rowSp\":{{{sp}}},\"doubts\":[{}],\"meter\":{{\"checked\":{},\"fullBefore\":{},\"fullAfter\":{},\"fixed\":{}}}}}", self.vector, ds.join(","), m.checked, m.full_before, m.full_after, m.fixed));
        o
    }
}
