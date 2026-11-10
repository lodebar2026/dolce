//! **网点与网纹**：半调网点印刷页去网、网纹填充补针孔、网点水印抹孤点。都只在量出来是这种页时才做——
//! 干净位图与普通扫描件的笔画本来就是实心的，做一遍只会把细节磨掉。参数全从本页谱表带里统计。
use dolce_omr_core::geom::quantile;
use dolce_omr_core::image::Binary;
use dolce_omr_core::pixel::morph::box_morph;
use dolce_omr_core::pixel::texture::{drop_specks, halftone_counts, pinhole_counts};
use dolce_omr_sheet::Staff;

/// 判半调网点的门槛（谱表带内、线上孤点不计的孤立点占比）。实测该去网的 0.169；满页网点水印、不该去网的 0.101；其余 0.03 以下。
const HALFTONE_RATIO: f64 = 0.13;
/// 量网点率时谱表上下各带出几个线距（歌词、和弦字母不进来）。
const HALFTONE_BAND: f64 = 2.0;
/// 判网纹填充的门槛（墨里被墨围住的白点占比）。要补的 0.017 起；不该补的 0.0096 以下。
const PINHOLE_RATIO: f64 = 0.012;
/// 64 见方一块里孤立单像素墨点多过这么多，这一块（连同四邻）才抹。
const SPECK_MIN: u32 = 40;
const SPECK_TILE: usize = 64;
/// 统计「点」的尺寸只看这么小的块（像素）。
const DOT_SCAN: usize = 60;
/// 底纹点：面积小于墨点尺寸（`DOT_PCT` 分位）这么多倍的抹掉。
const SPECK_K: f64 = 3.0;
/// 网点白隙：面积小于白隙尺寸这么多倍的被围白块填上（空心头内腔大一个量级）。
const GAP_K: f64 = 8.0;
const DOT_PCT: f64 = 0.9;

/// 清理一页的网点 / 网纹（就地改 `bin`），回网点率；没有谱表回 `None`（没有尺子，也没有东西要认）。
/// `allow_descreen`：网点率过门槛时可以整页去网（否则只补针孔、抹孤点）。
pub fn clean_texture(bin: &mut Binary, staves: &[Staff], allow_descreen: bool) -> Option<f64> {
    if staves.is_empty() {
        return None;
    }
    let (w, h) = (bin.w, bin.h);
    let mut rows = vec![0u8; h];
    for s in staves {
        let sp = s.space();
        let xs = [s.left, (s.left + s.right) / 2.0, s.right];
        let a = xs.iter().map(|&x| s.top(x)).fold(f64::INFINITY, f64::min) - sp * HALFTONE_BAND;
        let b = xs.iter().map(|&x| s.bottom(x)).fold(f64::NEG_INFINITY, f64::max) + sp * HALFTONE_BAND;
        for y in (a.ceil().max(0.0) as usize)..(b.floor().max(0.0) as usize).min(h) {
            rows[y] = 1;
        }
    }
    // 压在谱线上的像素不算孤点：细线扫描件的谱线断成一串点，全算进来网点率虚抬过门槛
    let mut sps: Vec<f64> = staves.iter().map(|s| s.space()).collect();
    sps.sort_by(f64::total_cmp);
    let tol = ((sps[sps.len() / 2] * 0.12).round() as i64).max(1);
    let mut on_line = vec![0u8; w * h];
    for s in staves {
        let ks: &[usize] = if s.one_line { &[2] } else { &[0, 1, 2, 3, 4] };
        for &k in ks {
            for x in (s.left.max(0.0) as usize)..=(s.right as usize).min(w - 1) {
                let y0 = s.line_y(k, x as f64).round() as i64;
                for y in (y0 - tol).max(0)..=(y0 + tol).min(h as i64 - 1) {
                    on_line[y as usize * w + x] = 1;
                }
            }
        }
    }
    let (ink, lone) = halftone_counts(&bin.data, w, h, &rows, &on_line);
    let halftone = if ink > 0 { lone as f64 / ink as f64 } else { 0.0 };
    if halftone > HALFTONE_RATIO && allow_descreen {
        descreen(bin, &rows);
    } else {
        let (ink, holes) = pinhole_counts(&bin.data, w, h, &rows);
        if ink > 0 && holes as f64 / ink as f64 > PINHOLE_RATIO {
            fill_pinholes(bin);
        }
    }
    // 网点水印：按块看孤点密度，只抹密的那几块
    drop_specks(&mut bin.data, w, h, SPECK_MIN, SPECK_TILE);
    Some(halftone)
}

/// 补针孔：八邻域里至少六个是墨、或上下左右四邻全是墨（棋盘格抖动）的白点补成墨，补两遍。
fn fill_pinholes(bin: &mut Binary) {
    let (w, h) = (bin.w, bin.h);
    for _ in 0..2 {
        let d = &bin.data;
        let mut add = Vec::new();
        for y in 1..h.saturating_sub(1) {
            for x in 1..w - 1 {
                let i = y * w + x;
                if d[i] != 0 {
                    continue;
                }
                let n4 = d[i - w] + d[i - 1] + d[i + 1] + d[i + w];
                let n = n4 + d[i - w - 1] + d[i - w + 1] + d[i + w - 1] + d[i + w + 1];
                if n >= 6 || n4 == 4 {
                    add.push(i);
                }
            }
        }
        if add.is_empty() {
            break;
        }
        for i in add {
            bin.data[i] = 1;
        }
    }
}

/// 按形态学去网：面积开（抹底纹点）→ 面积闭（填网点白隙）→ 方形闭（补碰着外面的白隙）。
fn descreen(bin: &mut Binary, rows: &[u8]) {
    let (w, h) = (bin.w, bin.h);
    let in_band = |c: &Comp| rows[(c.y0 + c.y1) / 2] != 0;
    let dots: Vec<f64> = comps(bin, 1, true).iter().filter(|c| c.px.len() <= DOT_SCAN && in_band(c)).map(|c| c.px.len() as f64).collect();
    let min = (quantile(&dots, DOT_PCT) * SPECK_K).max(2.0);
    for c in comps(bin, 1, true) {
        if (c.px.len() as f64) < min {
            for i in c.px {
                bin.data[i] = 0;
            }
        }
    }
    let holes = comps(bin, 0, false);
    let gaps: Vec<f64> = holes.iter().filter(|c| c.px.len() <= DOT_SCAN && !c.edge && in_band(c)).map(|c| c.px.len() as f64).collect();
    let gap = quantile(&gaps, DOT_PCT).max(1.0);
    for c in holes {
        if !c.edge && (c.px.len() as f64) < gap * GAP_K {
            for i in c.px {
                bin.data[i] = 1;
            }
        }
    }
    let r = (gap.sqrt().round() as usize).max(1);
    box_morph(&mut bin.data, w, h, r, true);
    box_morph(&mut bin.data, w, h, r, false);
}

struct Comp {
    px: Vec<usize>,
    y0: usize,
    y1: usize,
    edge: bool,
}

/// 值为 `v` 的连通块（`eight`：8 邻接，否则 4 邻接）。白底那一整块也会出来（调用方按大小、碰边筛）。
fn comps(bin: &Binary, v: u8, eight: bool) -> Vec<Comp> {
    let (w, h) = (bin.w, bin.h);
    let mut seen = vec![false; w * h];
    let mut out = Vec::new();
    let mut stack = Vec::new();
    for i0 in 0..w * h {
        if seen[i0] || bin.data[i0] != v {
            continue;
        }
        seen[i0] = true;
        stack.push(i0);
        let mut c = Comp { px: Vec::new(), y0: h, y1: 0, edge: false };
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            c.px.push(i);
            c.y0 = c.y0.min(y);
            c.y1 = c.y1.max(y);
            if x == 0 || y == 0 || x + 1 == w || y + 1 == h {
                c.edge = true;
            }
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    if (dx == 0 && dy == 0) || (!eight && dx != 0 && dy != 0) {
                        continue;
                    }
                    let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                    if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                        continue;
                    }
                    let j = ny as usize * w + nx as usize;
                    if !seen[j] && bin.data[j] == v {
                        seen[j] = true;
                        stack.push(j);
                    }
                }
            }
        }
        out.push(c);
    }
    out
}
