//! 对应 `src/omrkit/preprocess.ts` 的 `toGray`、`sauvolaMulti` 与 `src/rasteromr/rasterpage.ts` 的 `upsample`。
//! 浮点算式与取整照 TS 逐项照搬（`|0` 截断、`+0.5|0` 舍入、f64 积分图）。

const SAUVOLA_R: f64 = 128.0;

/// Rec.601 luma 截断取整；`step` = 每像素几个字节（1 = 已是灰度，原样拷）。
pub fn to_gray(px: &[u8], w: usize, h: usize, step: usize) -> Vec<u8> {
    let n = w * h;
    let mut g = vec![0u8; n];
    let mut p = 0usize;
    for v in g.iter_mut() {
        *v = if step == 1 { px[p] } else { (px[p] as f64 * 0.299 + px[p + 1] as f64 * 0.587 + px[p + 2] as f64 * 0.114) as i32 as u8 };
        p += step;
    }
    g
}

/// 几档 `k` 共用一份积分图；`out` 长 `ks.len() * w * h`，第 j 档写在第 j 段。
pub fn sauvola_multi(gray: &[u8], w: usize, h: usize, r: usize, ks: &[f64], out: &mut [u8]) {
    let sw = w + 1;
    let mut s1 = vec![0f64; sw * (h + 1)];
    let mut s2 = vec![0f64; sw * (h + 1)];
    for y in 0..h {
        let (mut r1, mut r2) = (0f64, 0f64);
        for x in 0..w {
            let v = gray[y * w + x] as f64;
            r1 += v;
            r2 += v * v;
            s1[(y + 1) * sw + x + 1] = s1[y * sw + x + 1] + r1;
            s2[(y + 1) * sw + x + 1] = s2[y * sw + x + 1] + r2;
        }
    }
    let n = w * h;
    for y in 0..h {
        let y0 = y.saturating_sub(r);
        let y1 = h.min(y + r + 1);
        for x in 0..w {
            let x0 = x.saturating_sub(r);
            let x1 = w.min(x + r + 1);
            let cnt = ((x1 - x0) * (y1 - y0)) as f64;
            let b1 = s1[y1 * sw + x1] - s1[y0 * sw + x1] - s1[y1 * sw + x0] + s1[y0 * sw + x0];
            let b2 = s2[y1 * sw + x1] - s2[y0 * sw + x1] - s2[y1 * sw + x0] + s2[y0 * sw + x0];
            let m = b1 / cnt;
            let v = 0f64.max(b2 / cnt - m * m);
            let sd = v.sqrt() / SAUVOLA_R - 1.0;
            let g = gray[y * w + x] as f64;
            for (j, &k) in ks.iter().enumerate() {
                out[j * n + y * w + x] = (g <= m * (1.0 + k * sd)) as u8;
            }
        }
    }
}

/// 灰度图双线性放大 `up` 倍（像素中心对齐）。
pub fn upsample(gray: &[u8], w: usize, h: usize, up: usize) -> Vec<u8> {
    let (ww, hh) = (w * up, h * up);
    let mut out = vec![0u8; ww * hh];
    let upf = up as f64;
    for yy in 0..hh {
        let fy = ((h - 1) as f64).min(0f64.max((yy as f64 + 0.5) / upf - 0.5));
        let y0 = fy.floor() as usize;
        let y1 = (h - 1).min(y0 + 1);
        let ty = fy - y0 as f64;
        for xx in 0..ww {
            let fx = ((w - 1) as f64).min(0f64.max((xx as f64 + 0.5) / upf - 0.5));
            let x0 = fx.floor() as usize;
            let x1 = (w - 1).min(x0 + 1);
            let tx = fx - x0 as f64;
            let a = gray[y0 * w + x0] as f64 * (1.0 - tx) + gray[y0 * w + x1] as f64 * tx;
            let b = gray[y1 * w + x0] as f64 * (1.0 - tx) + gray[y1 * w + x1] as f64 * tx;
            out[yy * ww + xx] = (a * (1.0 - ty) + b * ty + 0.5) as i32 as u8;
        }
    }
    out
}
