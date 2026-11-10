//! **符头候选**（3.1，现只有实心头）：在原图上找，不去线。
//!
//! 1. 种子：逐行谱、逐音级位置沿 x 扫，以该位置为中心的一个小实心框（比符头内接矩形略小）几乎全是墨的地方。
//!    头压着的谱线在墨层里本来就是墨（纵向墨段长），框里不用管线；符杠、粗笔画不够厚，撑不满这个框。
//! 2. 模板：本页挂得上符干的种子叠出一张「此处是墨的概率」图（线上存疑像素不参加统计），按线距归一，各行谱共用；
//!    再拿它给每个种子打分——模板里拿得准的像素（概率离 0.5 远的）权重大，图上的存疑像素两边都不算。
//!    符干在头的哪一侧不定，叠出来那一带概率在 0.5 上下，自然不计分。
use crate::frame::ink::{InkLayers, INK, LINE};
use crate::page::PageFrame;
use serde::{Deserialize, Serialize};

/// 扫的音级位置范围（第一线 0、往下每半格 +1）：谱表上下各四条加线。
pub const POS_MIN: i32 = -9;
pub const POS_MAX: i32 = 17;
/// 种子框的宽高（相对线距）与要求的墨占比。
pub(crate) const SEED_W: f64 = 0.8;
pub(crate) const SEED_H: f64 = 0.6;
pub(crate) const SEED_FILL: f64 = 0.9;
/// 种子框上下可挪多少（相对线距）找最满的位置。
const SEED_SLACK: f64 = 0.1;
/// 连着这么宽（相对线距）都撑得满的是实心块，不是符头。
const SEED_RUN: f64 = 1.0;
/// 两个种子横向相隔不到这么多（相对线距）、音级差不过 1 的是同一处墨，留更满的。
const SAME_X: f64 = 0.6;
/// 模板每格线距的采样数与半宽、半高（格数）：横向 ±0.94 格、纵向 ±0.62 格（再高会把和弦里上下相邻的头算进来）。
const TPL_RES: f64 = 16.0;
const TPL_HX: i64 = 15;
const TPL_HY: i64 = 10;
/// 自举模板至少要这么多个样本；不够用合成的椭圆。
const TPL_MIN: usize = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum HeadKind {
    /// 实心头。
    Filled,
    /// 空心头带干（二分音符）。
    Half,
    /// 全音符。
    Whole,
}

/// 一个符头候选。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Head {
    /// 哪一行谱（页内下标）。
    pub staff: usize,
    /// 中心（像素）。
    pub x: f64,
    pub y: f64,
    /// 音级位置。
    pub pos: i32,
    pub kind: HeadKind,
    /// 种子框的墨占比。
    pub fill: f64,
    /// 模板分（0~1）。
    pub score: f64,
    /// 头前的临时记号：升 1、降 −1、还原 0（[`super::marks`]）。
    pub acc: Option<i8>,
}

/// 符号墨（存疑像素不算）的积分图。
pub struct InkSum {
    w: usize,
    h: usize,
    s: Vec<u32>,
}

impl InkSum {
    pub fn new(ink: &InkLayers) -> Self {
        let (w, h) = (ink.w, ink.h);
        let mut s = vec![0u32; (w + 1) * (h + 1)];
        for y in 0..h {
            let mut row = 0u32;
            for x in 0..w {
                row += (ink.tri[y * w + x] == INK) as u32;
                s[(y + 1) * (w + 1) + x + 1] = s[y * (w + 1) + x + 1] + row;
            }
        }
        InkSum { w, h, s }
    }

    /// 框 [x0, x1) × [y0, y1) 里的墨像素数（出图部分不计）。
    pub fn count(&self, x0: i64, y0: i64, x1: i64, y1: i64) -> u32 {
        let cx = |v: i64| v.clamp(0, self.w as i64) as usize;
        let cy = |v: i64| v.clamp(0, self.h as i64) as usize;
        let (x0, x1, y0, y1) = (cx(x0), cx(x1), cy(y0), cy(y1));
        if x1 <= x0 || y1 <= y0 {
            return 0;
        }
        let w1 = self.w + 1;
        self.s[y1 * w1 + x1] + self.s[y0 * w1 + x0] - self.s[y0 * w1 + x1] - self.s[y1 * w1 + x0]
    }
}

/// 一行谱管的纵向范围：到上下邻行的中点为止（两行之间的加线音归近的那一行）。
pub(crate) fn band(f: &PageFrame, si: usize) -> (f64, f64) {
    let s = &f.staves[si];
    let x = (s.left + s.right) / 2.0;
    let lo = if si > 0 { (f.staves[si - 1].bottom(x) + s.top(x)) / 2.0 } else { 0.0 };
    let hi = if si + 1 < f.staves.len() { (s.bottom(x) + f.staves[si + 1].top(x)) / 2.0 } else { f.ink.h as f64 };
    (lo, hi)
}

/// 一行谱的种子。`ink` / `sum`：量满不满用的墨层（封过口的，见 [`InkLayers::sealed`]）与它的积分图。（`x_from` 之右：行首区的谱号、调号、拍号不进候选）。同一处墨在相邻音级上都撑得满的各出一个，不在这里取舍。
pub fn seeds(f: &PageFrame, ink: &InkLayers, sum: &InkSum, si: usize, x_from: f64) -> Vec<Head> {
    let s = &f.staves[si];
    let sp = s.space();
    let (bw, bh) = (((SEED_W * sp).round() as i64).max(3), ((SEED_H * sp).round() as i64).max(3));
    let area = (bw * bh) as f64;
    let slack = ((SEED_SLACK * sp).round() as i64).max(1);
    let (lo, hi) = band(f, si);
    let (xa, xb) = (x_from.ceil().max(0.0) as i64, (s.right.floor() as i64).min(f.ink.w as i64 - 1));
    let mut out: Vec<Head> = Vec::new();
    for p in POS_MIN..=POS_MAX {
        // 当前这一截撑得满的列：(起点, 终点, 最满的占比, 那一列的 x, y)
        let mut run: Option<(i64, i64, f64, i64, i64)> = None;
        let mut close = |run: &mut Option<(i64, i64, f64, i64, i64)>| {
            if let Some((a, b, fill, _, y)) = run.take() {
                if ((b - a + 1) as f64) <= SEED_RUN * sp {
                    out.push(Head { staff: si, x: (a + b) as f64 / 2.0, y: y as f64, pos: p, kind: HeadKind::Filled, fill, score: 0.0, acc: None });
                }
            }
        };
        for x in xa..=xb {
            let yc = s.y_of(x as f64, p as f64);
            if yc < lo || yc > hi {
                close(&mut run);
                continue;
            }
            let yc = yc.round() as i64;
            if ink.at(x, yc) != INK {
                close(&mut run);
                continue;
            }
            let mut best = (0.0, yc);
            for dy in -slack..=slack {
                let (x0, y0) = (x - bw / 2, yc + dy - bh / 2);
                let c = sum.count(x0, y0, x0 + bw, y0 + bh) as f64 / area;
                // 一样满取离格点近的
                if c > best.0 + 1e-9 || (c > best.0 - 1e-9 && dy.abs() < (best.1 - yc).abs()) {
                    best = (c, yc + dy);
                }
            }
            if best.0 < SEED_FILL {
                close(&mut run);
                continue;
            }
            match &mut run {
                Some(r) => {
                    r.1 = x;
                    if best.0 > r.2 {
                        (r.2, r.3, r.4) = (best.0, x, best.1);
                    }
                }
                None => run = Some((x, x, best.0, x, best.1)),
            }
        }
        close(&mut run);
    }
    out.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.pos.cmp(&b.pos)));
    out
}

/// 两个候选争同一处墨：横向相隔不到 `SAME_X` 格、音级差不过 1（头偏大、落在两格点之间时相邻音级上都撑得满）。
pub fn same_ink(a: &Head, b: &Head, sp: f64) -> bool {
    a.staff == b.staff && (a.x - b.x).abs() < SAME_X * sp && (a.pos - b.pos).abs() <= 1
}

/// 争同一处墨的种子只留最满的一个（自举模板取样用：这时还没有模板分；正式的取舍在 [`super::resolve`] 里按模板分做）。
pub fn fullest(mut seeds: Vec<Head>, sp: f64) -> Vec<Head> {
    seeds.sort_by(|a, b| b.fill.total_cmp(&a.fill).then(a.x.total_cmp(&b.x)));
    let mut kept: Vec<Head> = Vec::new();
    for h in seeds {
        if !kept.iter().any(|k| same_ink(k, &h, sp)) {
            kept.push(h);
        }
    }
    kept.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.pos.cmp(&b.pos)));
    kept
}

/// 符头模板：`w × h` 格，每格是「此处是墨」的概率。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Template {
    pub t: Vec<f32>,
}

const TPL_W: usize = (TPL_HX * 2 + 1) as usize;
const TPL_H: usize = (TPL_HY * 2 + 1) as usize;

#[inline]
fn cell(ink: &InkLayers, cx: f64, cy: f64, sp: f64, i: usize, j: usize) -> u8 {
    let x = (cx + (i as f64 - TPL_HX as f64) / TPL_RES * sp).round() as i64;
    let y = (cy + (j as f64 - TPL_HY as f64) / TPL_RES * sp).round() as i64;
    ink.at(x, y)
}

impl Template {
    /// 由样本（中心与所在行的线距）叠出来；样本不够回 None。
    pub fn bootstrap(ink: &InkLayers, samples: &[(f64, f64, f64)]) -> Option<Self> {
        if samples.len() < TPL_MIN {
            return None;
        }
        let mut on = vec![0u32; TPL_W * TPL_H];
        let mut n = vec![0u32; TPL_W * TPL_H];
        for &(cx, cy, sp) in samples {
            for j in 0..TPL_H {
                for i in 0..TPL_W {
                    match cell(ink, cx, cy, sp, i, j) {
                        LINE => {}
                        v => {
                            n[j * TPL_W + i] += 1;
                            on[j * TPL_W + i] += (v == INK) as u32;
                        }
                    }
                }
            }
        }
        // 统计不到几个样本的格子（总压在线上）不拿主意
        let need = (samples.len() as u32 / 4).max(2);
        Some(Template { t: on.iter().zip(&n).map(|(&a, &b)| if b >= need { a as f32 / b as f32 } else { 0.5 }).collect() })
    }

    /// 合成的斜椭圆（长半轴 0.62 格、短半轴 0.44 格、右端上翘 20°）：页上样本不够时用。
    pub fn synthetic() -> Self {
        let (a, b, th) = (0.62f64, 0.44f64, 20f64.to_radians());
        let mut t = vec![0f32; TPL_W * TPL_H];
        for j in 0..TPL_H {
            for i in 0..TPL_W {
                let (x, y) = ((i as f64 - TPL_HX as f64) / TPL_RES, -(j as f64 - TPL_HY as f64) / TPL_RES);
                let (u, v) = (x * th.cos() + y * th.sin(), -x * th.sin() + y * th.cos());
                let d = (u / a).powi(2) + (v / b).powi(2);
                t[j * TPL_W + i] = if d <= 0.85 { 1.0 } else if d >= 1.2 { 0.0 } else { 0.5 };
            }
        }
        Template { t }
    }

    /// (cx, cy) 处与模板的吻合度（0~1）：拿得准的格子按把握加权，图上的存疑像素不计。
    pub fn score(&self, ink: &InkLayers, cx: f64, cy: f64, sp: f64) -> f64 {
        let (mut agree, mut total) = (0f64, 0f64);
        for j in 0..TPL_H {
            for i in 0..TPL_W {
                let p = self.t[j * TPL_W + i] as f64;
                let w = (2.0 * p - 1.0).abs();
                if w < 0.2 {
                    continue;
                }
                let v = cell(ink, cx, cy, sp, i, j);
                if v == LINE {
                    continue;
                }
                total += w;
                if (v == INK) == (p > 0.5) {
                    agree += w;
                }
            }
        }
        if total > 0.0 { agree / total } else { 0.0 }
    }

    /// 在 (cx, cy) 附近挪一挪（±`r` 像素）取最高分：种子中心是按小框定的，差一两个像素。
    pub fn best_score(&self, ink: &InkLayers, cx: f64, cy: f64, sp: f64, r: i64) -> (f64, f64, f64) {
        let mut best = (self.score(ink, cx, cy, sp), cx, cy);
        for dy in -r..=r {
            for dx in -r..=r {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let s = self.score(ink, cx + dx as f64, cy + dy as f64, sp);
                if s > best.0 {
                    best = (s, cx + dx as f64, cy + dy as f64);
                }
            }
        }
        best
    }
}
