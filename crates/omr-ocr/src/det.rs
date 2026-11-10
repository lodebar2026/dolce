//! DBNet 文本检测：子图缩到边长 960 以内、宽高对齐 32 → 概率图 > 0.3 的 4 邻接块 → 块均分 ≥ 0.5 的外扩成行框。
use crate::surface::{blit, Gray};
use crate::{Infer, Model};
use dolce_omr_core::image::Rect;

const LIMIT: f64 = 960.0;
const THRESH: f32 = 0.3;
const BOX_THRESH: f64 = 0.5;
/// DBNet 训练时把文字框收缩过，外扩还原：dist = 面积 × ratio / 周长。
const UNCLIP: f64 = 1.6;
/// 分块检测相邻两块叠这么多（块边长的比例）。
const TILE_OVERLAP: f64 = 0.2;
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

pub fn detect_region(infer: &dyn Infer, src: &Gray, region: Rect) -> Result<Vec<Rect>, String> {
    let rx = region.x.round().max(0.0);
    let ry = region.y.round().max(0.0);
    let rw = (src.w as f64 - rx).min(region.w.round());
    let rh = (src.h as f64 - ry).min(region.h.round());
    if rw < 8.0 || rh < 8.0 {
        return Ok(Vec::new());
    }
    let scale = (LIMIT / rw.max(rh)).min(1.0);
    let r32 = |n: f64| (((n * scale) / 32.0).round() * 32.0).max(32.0) as usize;
    let (w, h) = (r32(rw), r32(rh));
    let (sx, sy) = (w as f64 / rw, h as f64 / rh);
    let mut tmp = Gray::new(w, h, 255);
    blit(&mut tmp, src, Rect::new(rx, ry, rw, rh), Rect::new(0.0, 0.0, w as f64, h as f64));
    let plane = w * h;
    let mut t = vec![0f32; 3 * plane];
    for (p, &v) in tmp.data.iter().enumerate() {
        for c in 0..3 {
            t[c * plane + p] = (v as f32 / 255.0 - MEAN[c]) / STD[c];
        }
    }
    let (prob, _) = infer.run(Model::Det, t, &[1, 3, h, w])?;
    let mut boxes = Vec::new();
    for k in components(&prob, w, h) {
        let (bw, bh) = ((k.x1 - k.x0 + 1) as f64, (k.y1 - k.y0 + 1) as f64);
        if bw < 4.0 || bh < 4.0 || k.sum / (k.n as f64) < BOX_THRESH {
            continue;
        }
        let d = bw * bh * UNCLIP / (2.0 * (bw + bh));
        let (ex0, ey0, ex1, ey1) = (k.x0 as f64 - d, k.y0 as f64 - d, k.x1 as f64 + d, k.y1 as f64 + d);
        boxes.push(Rect::new(rx + ex0 / sx, ry + ey0 / sy, (ex1 - ex0) / sx, (ey1 - ey0) / sy));
    }
    // 阅读序：纵向差过行高中位数六成的按上下，否则按左右
    let mut hs: Vec<f64> = boxes.iter().map(|b| b.h).collect();
    hs.sort_by(f64::total_cmp);
    let med = hs.get(hs.len() / 2).copied().unwrap_or(0.0);
    boxes.sort_by(|a, b| if (a.y - b.y).abs() > med * 0.6 { a.y.total_cmp(&b.y) } else { a.x.total_cmp(&b.x) });
    Ok(boxes)
}

struct Comp {
    x0: usize,
    y0: usize,
    x1: usize,
    y1: usize,
    n: usize,
    sum: f64,
}

/// 概率图 > 阈值的 4 邻接块（块按首像素的光栅序）。
fn components(prob: &[f32], w: usize, h: usize) -> Vec<Comp> {
    let mut seen = vec![false; w * h];
    let mut out = Vec::new();
    let mut stack = Vec::new();
    for i0 in 0..w * h {
        if seen[i0] || prob[i0] <= THRESH {
            continue;
        }
        seen[i0] = true;
        stack.push(i0);
        let mut k = Comp { x0: w, y0: h, x1: 0, y1: 0, n: 0, sum: 0.0 };
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            k.n += 1;
            k.sum += prob[i] as f64;
            k.x0 = k.x0.min(x);
            k.x1 = k.x1.max(x);
            k.y0 = k.y0.min(y);
            k.y1 = k.y1.max(y);
            let mut push = |j: usize| {
                if !seen[j] && prob[j] > THRESH {
                    seen[j] = true;
                    stack.push(j);
                }
            };
            if x > 0 {
                push(i - 1);
            }
            if x + 1 < w {
                push(i + 1);
            }
            if y > 0 {
                push(i - w);
            }
            if y + 1 < h {
                push(i + w);
            }
        }
        out.push(k);
    }
    out
}

pub fn detect_tiled(infer: &dyn Infer, src: &Gray, region: Rect, scale: f64) -> Result<Vec<Rect>, String> {
    let t = (LIMIT / scale.min(1.0)).round();
    let ov = (t * TILE_OVERLAP).round();
    let (x0, y0) = (region.x.round().max(0.0), region.y.round().max(0.0));
    let (x1, y1) = ((src.w as f64).min(region.right().round()), (src.h as f64).min(region.bottom().round()));
    let starts = |a: f64, b: f64| {
        let mut v = Vec::new();
        let mut s = a;
        loop {
            let p = s.min(a.max(b - t));
            if !v.contains(&p) {
                v.push(p);
            }
            if s + t >= b {
                break;
            }
            s += t - ov;
        }
        v
    };
    let mut got = Vec::new();
    for &ty in &starts(y0, y1) {
        for &tx in &starts(x0, x1) {
            let (tw, th) = (t.min(x1 - tx), t.min(y1 - ty));
            // 每块只收中心落在本块「芯」里的框（芯 = 块往里让半个重叠带，页边那一侧不让）
            let cx0 = if tx == x0 { x0 } else { tx + ov / 2.0 };
            let cy0 = if ty == y0 { y0 } else { ty + ov / 2.0 };
            let cx1 = if tx + tw >= x1 { x1 } else { tx + tw - ov / 2.0 };
            let cy1 = if ty + th >= y1 { y1 } else { ty + th - ov / 2.0 };
            for b in detect_region(infer, src, Rect::new(tx, ty, tw, th))? {
                let (cx, cy) = (b.cx(), b.cy());
                if cx >= cx0 && cx < cx1 && cy >= cy0 && cy < cy1 {
                    got.push(b);
                }
            }
        }
    }
    // 同一行（纵向重叠过矮者六成）、横向首尾相接（空当不过矮者高的一半）的并成一个框
    got.sort_by(|a, b| a.x.total_cmp(&b.x));
    'outer: loop {
        for i in 0..got.len() {
            for j in i + 1..got.len() {
                let (a, b) = (got[i], got[j]);
                let h = a.h.min(b.h);
                let vy = a.bottom().min(b.bottom()) - a.y.max(b.y);
                let gap = a.x.max(b.x) - a.right().min(b.right());
                if vy < h * 0.6 || gap > h * 0.5 {
                    continue;
                }
                got[i] = dolce_omr_core::geom::union_rect(&a, &b);
                got.remove(j);
                continue 'outer;
            }
        }
        break;
    }
    got.sort_by(|a, b| a.y.total_cmp(&b.y).then(a.x.total_cmp(&b.x)));
    Ok(got)
}
