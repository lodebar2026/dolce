//! 对应 `src/rasteromr/headmask.ts` 的 `scoreAt`、`scoreAtMasked`（模板值是 f32，累加照 TS 按 f64、同次序）。

/// 窗口左上角取 `round(c - m/2)`（JS `Math.round`：.5 向正无穷）。不写成 `floor(v + 0.5)`：
/// 0.49999999999999994 加 0.5 会舍成 1.0，与 JS 不同；`v - floor(v)` 在这个量级是精确的。
fn js_round(v: f64) -> i64 {
    let f = v.floor();
    (if v - f >= 0.5 { f + 1.0 } else { f }) as i64
}

pub fn score_at(data: &[u8], w: usize, h: usize, p: &[f32], mw: usize, mh: usize, cx: f64, cy: f64) -> f64 {
    let x0 = js_round(cx - mw as f64 / 2.0);
    let y0 = js_round(cy - mh as f64 / 2.0);
    let (mut hit, mut hit_w, mut spill, mut spill_w) = (0f64, 0f64, 0f64, 0f64);
    for y in 0..mh {
        let sy = y0 + y as i64;
        if sy < 0 || sy >= h as i64 {
            continue;
        }
        for x in 0..mw {
            let sx = x0 + x as i64;
            if sx < 0 || sx >= w as i64 {
                continue;
            }
            let pv = p[y * mw + x] as f64;
            let v = data[sy as usize * w + sx as usize] as f64;
            hit += pv * v;
            hit_w += pv;
            spill += (1.0 - pv) * v;
            spill_w += 1.0 - pv;
        }
    }
    (if hit_w != 0.0 { hit / hit_w } else { 0.0 }) - (if spill_w != 0.0 { spill / spill_w } else { 0.0 })
}

/// `stem_x` 为 NaN 表示没给干。
#[allow(clippy::too_many_arguments)]
pub fn score_at_masked(data: &[u8], w: usize, h: usize, p: &[f32], mw: usize, mh: usize, cx: f64, cy: f64, stem_x: f64, stem_half: f64) -> f64 {
    let x0 = js_round(cx - mw as f64 / 2.0);
    let y0 = js_round(cy - mh as f64 / 2.0);
    let (mut hit, mut hit_w, mut spill, mut spill_w) = (0f64, 0f64, 0f64, 0f64);
    let mwf = mw as f64;
    for y in 0..mh {
        let sy = y0 + y as i64;
        if sy < 0 || sy >= h as i64 {
            continue;
        }
        let row_base = sy as usize * w;
        let mut row = 0f64;
        for x in 0..mw {
            let sx = x0 + x as i64;
            if sx >= 0 && sx < w as i64 {
                row += data[row_base + sx as usize] as f64;
            }
        }
        if row >= mwf * 0.9 {
            continue;
        }
        let mut pr = 0f64;
        for x in 0..mw {
            pr += p[y * mw + x] as f64;
        }
        if pr >= mwf * 0.8 {
            continue;
        }
        for x in 0..mw {
            let sx = x0 + x as i64;
            if sx < 0 || sx >= w as i64 {
                continue;
            }
            if !stem_x.is_nan() && (sx as f64 - stem_x).abs() <= stem_half {
                continue;
            }
            let pv = p[y * mw + x] as f64;
            let v = data[row_base + sx as usize] as f64;
            hit += pv * v;
            hit_w += pv;
            spill += (1.0 - pv) * v;
            spill_w += 1.0 - pv;
        }
    }
    (if hit_w != 0.0 { hit / hit_w } else { 0.0 }) - (if spill_w != 0.0 { spill / spill_w } else { 0.0 })
}
