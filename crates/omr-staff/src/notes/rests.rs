//! **休止候选**（3.2）：从符号墨的墨块里认，不去线。休止符不挂干、不连别的符号，在墨层里各是孤立的一块。
//!
//! - 全 / 二分休止：实心的扁方块，贴着一条谱线——上沿贴线（吊着）的是全休止（整小节休止同形），下沿贴线（坐着）的是二分休止。
//! - 八分及更短：左上有实心的圆点、底下是一根向左下斜的细笔；圆点个数按块高分八分 / 十六分 / 三十二分。
//! - 四分：两格半到三格多高、一格上下宽的弯折笔画。没有孔（升降还原号都有孔）、没有长竖笔（符干、升降还原号的竖笔占块高的大半）。
use super::bridged;
use super::heads::{band, POS_MAX, POS_MIN, SEED_FILL, SEED_H, SEED_W};
use crate::frame::ink::LINE;
use crate::page::PageFrame;
use dolce_omr_core::image::Rect;
use dolce_omr_core::sheet::prims::VSeg;
use dolce_omr_core::sheet::score::NoteType;
use dolce_omr_core::sheet::Staff;
use serde::{Deserialize, Serialize};

/// 块状休止的宽、高范围（相对线距；高里含贴着的那条线）与占包围盒的比例。
const BLOCK_W: (f64, f64) = (0.9, 2.4);
const BLOCK_H: (f64, f64) = (0.35, 0.8);
const BLOCK_FILL: f64 = 0.8;
/// 块状休止贴线的那一沿离线心最远多少、另一沿离最近的线至少多少（半格为 1）。
const BLOCK_ON: f64 = 0.35;
const BLOCK_OFF: f64 = 0.5;
/// 弯折笔画（四分及更短）的宽范围（相对线距）。
const CURVY_W: (f64, f64) = (0.65, 1.5);
/// 带圆点的按块高分几个点（相对线距）：八分、十六分、三十二分。
const H_8TH: (f64, f64) = (1.4, 2.35);
const H_16TH: f64 = 3.5;
const H_32ND: f64 = 4.5;
/// 四分休止的高范围（相对线距）。顶上那段细笔贴着谱线时会被当成线、断在块外，下限留出这一截。
const H_QUARTER: (f64, f64) = (2.1, 3.5);
/// 最长的纵向墨段不过块高的这么多（有竖笔的不是休止：符干、降号的竖笔几乎与块等高；四分休止粗的那段到七成）。
const VRUN_MAX: f64 = 0.8;
/// 四分休止占包围盒的比例范围。
const QUARTER_FILL: (f64, f64) = (0.25, 0.65);
/// 八分休止的圆点：边长这么多（相对线距）的实心方框，落在块的上部左侧。
const DOT_SIDE: f64 = 0.4;
const DOT_FILL: f64 = 0.9;
/// 八分休止底下那段细笔：块高最底下这么多比例的各行，墨不宽过这么多（相对线距）。
const TAIL_PART: f64 = 0.3;
const TAIL_W: f64 = 0.45;
/// 细笔底端落在块宽的这一段里（比例）。
const TAIL_AT: (f64, f64) = (0.3, 0.85);
/// 圆点与斜笔之间隔着白的行至少这么多（相对线距）。
const GAP_ROWS: f64 = 0.1;
/// 夹在两块墨之间、横向不长过这么多（相对线距）的存疑像素算把两块连着。
const SLIT: f64 = 0.15;
/// 块心离中线不过这么多（半格为 1）：块状与四分休止在谱表里；带圆点的形状特征强，另一声部的常挪到谱表外，放到符头的音级范围。
const CENTER_TOL: f64 = 4.0;

/// 一个休止候选。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rest {
    pub staff: usize,
    /// 包围盒中心（像素）。
    pub x: f64,
    pub y: f64,
    pub ntype: NoteType,
    /// 包围盒 `(x, y, w, h)`。
    pub rect: (f64, f64, f64, f64),
    /// 附点数（[`super::marks`]）。
    pub dots: u8,
    /// 延长记号（[`super::artics`]）。
    #[serde(default)]
    pub arts: Vec<dolce_omr_core::sheet::score::Art>,
    /// 多小节休止的小节数（[`multi_rests`]；普通休止为 0）。整曲拼接时展开成这么多个整小节休止。
    #[serde(default)]
    pub measures: u16,
    /// 识别 id（同 [`super::heads::Head::rid`]）。
    #[serde(default)]
    pub rid: Option<dolce_omr_core::sheet::result::Rid>,
    /// 用户钉住的（同 [`super::Chord::pinned`]）。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub pinned: bool,
}

/// 多小节休止：横条高（相对线距）、至少多宽、条心离中线不过多远；两端竖线的高与离条端多远；数字在条上方不出多远。
const MR_BAR_H: (f64, f64) = (0.3, 0.8);
const MR_BAR_W: f64 = 3.0;
const MR_MID: f64 = 0.4;
const MR_END_H: (f64, f64) = (1.2, 3.0);
const MR_END_NEAR: f64 = 0.3;
const MR_NUM_UP: f64 = 4.0;

/// **多小节休止**（两种证据共用的判据）：谱表中线上一道粗横条（`bars`：实心横条的外框），两端各一笔竖线（`vsegs`），
/// 上方印小节数（`digits`：读出的数与外框，横向落在横条上方、离谱表顶不出 `MR_NUM_UP` 格）。没印数的不收。
pub fn multi_rests(staves: &[Staff], bars: &[Rect], vsegs: &[VSeg], digits: &[(u32, Rect)]) -> Vec<Rest> {
    let mut out = Vec::new();
    for b in bars {
        let (cx, cy) = (b.x + b.w / 2.0, b.y + b.h / 2.0);
        let Some((si, st)) = staves.iter().enumerate().find(|(_, s)| (s.ys[2] - cy).abs() <= MR_MID * s.space() && b.x >= s.left - s.space() && b.right() <= s.right + s.space()) else { continue };
        let sp = st.space();
        if b.w < MR_BAR_W * sp || b.h < MR_BAR_H.0 * sp || b.h > MR_BAR_H.1 * sp {
            continue;
        }
        let end = |x: f64| {
            vsegs.iter().any(|v| {
                let len = (v.y1 - v.y0) as f64;
                (v.cx() - x).abs() <= MR_END_NEAR * sp && len >= MR_END_H.0 * sp && len <= MR_END_H.1 * sp && ((v.y0 + v.y1) as f64 / 2.0 - cy).abs() <= 0.5 * sp
            })
        };
        if !end(b.x) || !end(b.right()) {
            continue;
        }
        let top = st.top(cx);
        let Some(&(n, _)) = digits.iter().find(|(_, r)| r.x + r.w / 2.0 >= b.x && r.x + r.w / 2.0 <= b.right() && r.bottom() <= top + 0.5 * sp && top - r.bottom() <= MR_NUM_UP * sp) else { continue };
        if n < 2 {
            continue;
        }
        out.push(Rest { staff: si, x: cx, y: cy, ntype: NoteType::Whole, rect: (b.x, b.y, b.w, b.h), dots: 0, arts: Vec::new(), measures: n.min(u16::MAX as u32) as u16, rid: None, pinned: false });
    }
    out
}

/// 一个墨块的像素（包围盒内，行优先）。
struct Mask {
    w: usize,
    h: usize,
    d: Vec<bool>,
}

impl Mask {
    /// 标号在 `ids` 里的墨块在框 `r` 里的像素；同一行里夹在这些墨之间、不长过 `slit` 的存疑像素也算。
    fn of(f: &PageFrame, ids: &[i32], r: Rect, slit: usize) -> Mask {
        let (x0, y0, w, h) = (r.x as usize, r.y as usize, r.w as usize, r.h as usize);
        let pw = f.ink.w;
        let mut d: Vec<bool> = (0..w * h).map(|i| ids.contains(&f.labels[(y0 + i / w) * pw + x0 + i % w])).collect();
        for y in 0..h {
            let mut x = 1;
            while x < w {
                if f.ink.tri[(y0 + y) * pw + x0 + x] != LINE || !d[y * w + x - 1] {
                    x += 1;
                    continue;
                }
                let a = x;
                while x < w && f.ink.tri[(y0 + y) * pw + x0 + x] == LINE {
                    x += 1;
                }
                if x < w && x - a <= slit && d[y * w + x] {
                    d[y * w + a..y * w + x].fill(true);
                }
            }
        }
        Mask { w, h, d }
    }

    fn at(&self, x: i64, y: i64) -> bool {
        x >= 0 && y >= 0 && (x as usize) < self.w && (y as usize) < self.h && self.d[y as usize * self.w + x as usize]
    }

    /// 框 [x0, x1) × [y0, y1) 里的墨占比。
    fn fill(&self, x0: usize, y0: usize, x1: usize, y1: usize) -> f64 {
        let n = (y0..y1).map(|y| (x0..x1).filter(|&x| self.d[y * self.w + x]).count()).sum::<usize>();
        n as f64 / ((x1 - x0) * (y1 - y0)).max(1) as f64
    }

    /// 最长的纵向墨段。
    fn max_vrun(&self) -> usize {
        let mut best = 0;
        for x in 0..self.w {
            let mut run = 0;
            for y in 0..self.h {
                run = if self.d[y * self.w + x] { run + 1 } else { 0 };
                best = best.max(run);
            }
        }
        best
    }

    /// 有没有孔（从包围盒外灌不到的底，面积不小于 `min_area`）。
    fn has_hole(&self, min_area: usize) -> bool {
        let (w, h) = (self.w + 2, self.h + 2);
        let mut seen = vec![false; w * h];
        let bg = |x: usize, y: usize| !self.at(x as i64 - 1, y as i64 - 1);
        let flood = |seen: &mut Vec<bool>, sx: usize, sy: usize| -> usize {
            let mut stack = vec![(sx, sy)];
            seen[sy * w + sx] = true;
            let mut n = 0;
            while let Some((x, y)) = stack.pop() {
                n += 1;
                for (dx, dy) in [(1i64, 0i64), (-1, 0), (0, 1), (0, -1)] {
                    let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                    if nx < 0 || ny < 0 || nx as usize >= w || ny as usize >= h {
                        continue;
                    }
                    let (nx, ny) = (nx as usize, ny as usize);
                    if !seen[ny * w + nx] && bg(nx, ny) {
                        seen[ny * w + nx] = true;
                        stack.push((nx, ny));
                    }
                }
            }
            n
        };
        flood(&mut seen, 0, 0);
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                if !seen[y * w + x] && bg(x, y) && flood(&mut seen, x, y) >= min_area {
                    return true;
                }
            }
        }
        false
    }

    /// 第 `y` 行的各段墨（左右端，含）。
    fn row_runs(&self, y: usize) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        let mut x = 0;
        while x < self.w {
            if !self.d[y * self.w + x] {
                x += 1;
                continue;
            }
            let a = x;
            while x < self.w && self.d[y * self.w + x] {
                x += 1;
            }
            out.push((a, x - 1));
        }
        out
    }

    /// 区域 [x0, x1) × [y0, y1) 里有没有一个 `bw` × `bh` 的框墨占比不低于 `fill`。
    #[allow(clippy::too_many_arguments)]
    fn has_solid(&self, x0: usize, y0: usize, x1: usize, y1: usize, bw: usize, bh: usize, fill: f64) -> bool {
        let (x1, y1) = (x1.min(self.w), y1.min(self.h));
        if x1 < x0 + bw || y1 < y0 + bh {
            return false;
        }
        (y0..=y1 - bh).any(|y| (x0..=x1 - bw).any(|x| self.fill(x, y, x + bw, y + bh) >= fill))
    }
}

/// 一行谱的休止候选（`x_from` 之右），按 x 排。
pub fn rests(f: &PageFrame, si: usize, x_from: f64) -> Vec<Rest> {
    let s = &f.staves[si];
    if s.one_line {
        return vec![];
    }
    let sp = s.space();
    let (lo, hi) = band(f, si);
    let mut out = Vec::new();
    let slit = ((sp * SLIT).round() as usize).max(2);
    for b in &f.blobs {
        if b.cx < x_from || b.cx > s.right || b.cy < lo || b.cy >= hi || b.rect.w > BLOCK_W.1 * sp || b.rect.h > H_32ND * sp {
            continue;
        }
        // 隔着细缝的另一块并进来一起判
        let mut ids = vec![b.id as i32];
        let mut r = b.rect;
        for pid in bridged(f, b, slit) {
            if let Some(o) = f.blobs.iter().find(|o| o.id as i32 == pid) {
                let (x1, y1) = ((r.x + r.w).max(o.rect.x + o.rect.w), (r.y + r.h).max(o.rect.y + o.rect.h));
                (r.x, r.y) = (r.x.min(o.rect.x), r.y.min(o.rect.y));
                (r.w, r.h) = (x1 - r.x, y1 - r.y);
                ids.push(pid);
            }
        }
        let (cx, cy) = (r.x + r.w / 2.0, r.y + r.h / 2.0);
        let pos = s.pos(cx, cy);
        let (bw, bh) = (r.w / sp, r.h / sp);
        if pos < POS_MIN as f64 || pos > POS_MAX as f64 || bw > BLOCK_W.1 || bh > H_32ND || bw < CURVY_W.0 || bh < BLOCK_H.0 {
            continue;
        }
        let m = Mask::of(f, &ids, r, slit);
        let ntype = if bh <= BLOCK_H.1 { block(s, &m, r.y, bw, cx) } else { curvy(&m, sp, bw, bh) };
        if let Some(ntype) = ntype.filter(|t| (pos - 4.0).abs() <= CENTER_TOL || matches!(t, NoteType::Eighth | NoteType::N16th | NoteType::N32nd)) {
            out.push(Rest { staff: si, x: cx, y: cy, ntype, rect: (r.x, r.y, r.w, r.h), dots: 0, arts: Vec::new(), measures: 0, rid: None, pinned: false });
        }
    }
    out.sort_by(|a, b| a.x.total_cmp(&b.x));
    // 两块并成的，从两头各认出一次
    out.dedup_by(|a, b| a.rect == b.rect);
    out
}

/// 全 / 二分休止：实心扁方块，一沿贴线、另一沿在间里。
fn block(s: &dolce_omr_core::sheet::Staff, m: &Mask, y: f64, bw: f64, cx: f64) -> Option<NoteType> {
    if bw < BLOCK_W.0 || m.fill(0, 0, m.w, m.h) < BLOCK_FILL {
        return None;
    }
    // 两沿各离最近的谱线多远（只看谱表里的五条线）
    let off = |yy: f64| {
        let p = s.pos(cx, yy);
        let near = ((p / 2.0).round() * 2.0).clamp(0.0, 8.0);
        (p - near).abs()
    };
    let (top, bottom) = (off(y), off(y + m.h as f64));
    if top <= BLOCK_ON && bottom >= BLOCK_OFF {
        Some(NoteType::Whole)
    } else if bottom <= BLOCK_ON && top >= BLOCK_OFF {
        Some(NoteType::Half)
    } else {
        None
    }
}

/// 四分及更短的休止：弯折笔画，没有孔、没有长竖笔。
fn curvy(m: &Mask, sp: f64, bw: f64, bh: f64) -> Option<NoteType> {
    if bw > CURVY_W.1 || bh < H_8TH.0 {
        return None;
    }
    if m.max_vrun() as f64 > VRUN_MAX * m.h as f64 || m.has_hole(((sp * sp * 0.03) as usize).max(3)) {
        return None;
    }
    if flagged(m, sp) {
        return Some(if bh < H_8TH.1 {
            NoteType::Eighth
        } else if bh < H_16TH {
            NoteType::N16th
        } else {
            NoteType::N32nd
        });
    }
    // 里面有符头那么大的实心团的是断了干的音符（两个头靠残干连着）。带圆点的不查：圆点坐在粗谱线上时连钩带线能凑满这个框
    let (hw, hh) = (((SEED_W * sp).round() as usize).max(3), ((SEED_H * sp).round() as usize).max(3));
    if m.has_solid(0, 0, m.w, m.h, hw, hh, SEED_FILL) {
        return None;
    }
    let fill = m.fill(0, 0, m.w, m.h);
    (bh >= H_QUARTER.0 && bh < H_QUARTER.1 && fill >= QUARTER_FILL.0 && fill <= QUARTER_FILL.1).then_some(NoteType::Quarter)
}

/// 八分及更短休止的样子：上部左侧有实心圆点；圆点那几行右边隔着一道白另有一笔（钩的末端接斜笔顶）；
/// 最底下一段是单根细笔，落在块宽的中段（斜笔向左下，圆点在它左边）。
fn flagged(m: &Mask, sp: f64) -> bool {
    let side = ((DOT_SIDE * sp).round() as usize).max(2);
    if m.w < side + 2 || m.h < side * 2 {
        return false;
    }
    // 圆点：落在块顶往下一格之内、左侧
    let (dy_max, dx_max) = ((sp as usize).min(m.h - side), (m.w - side) * 6 / 10);
    if !m.has_solid(0, 0, dx_max + side, dy_max + side, side, side, DOT_FILL) {
        return false;
    }
    // 圆点与斜笔之间的白：上部有几行恰是两段墨，左段有圆点那么宽
    let gap_rows = (0..dy_max + side)
        .filter(|&y| {
            let runs = m.row_runs(y);
            runs.len() == 2 && runs[0].1 - runs[0].0 + 1 >= side
        })
        .count();
    if (gap_rows as f64) < GAP_ROWS * sp {
        return false;
    }
    let from = m.h - ((TAIL_PART * m.h as f64) as usize).max(2);
    let mut tail_x = 0.0;
    for y in from..m.h {
        // 毛边的行断成几截也按首尾算
        let runs = m.row_runs(y);
        let (Some(a), Some(b)) = (runs.first().map(|r| r.0), runs.last().map(|r| r.1)) else { return false };
        if (b - a + 1) as f64 > TAIL_W * sp {
            return false;
        }
        tail_x += (a + b) as f64 / 2.0 / (m.h - from) as f64;
    }
    tail_x >= TAIL_AT.0 * m.w as f64 && tail_x <= TAIL_AT.1 * m.w as f64
}
