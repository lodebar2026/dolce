//! 对应 `src/omrkit/morph.ts` 的 `ellipseOpen` 与方形结构元的 `boxMorph`（`close` 由它组成）。

/// 椭圆结构元开运算，返回新图（不改原图）。
pub fn ellipse_open(data: &[u8], w: usize, h: usize, rx: i32, ry: i32) -> Vec<u8> {
    let n = (2 * ry + 1) as usize;
    let mut dys = vec![0i32; n];
    let mut ks = vec![0i32; n];
    let r = ry as f64 + 0.5;
    for i in 0..n {
        let dy = i as i32 - ry;
        dys[i] = dy;
        ks[i] = (rx as f64 * 0f64.max(1.0 - (dy * dy) as f64 / (r * r)).sqrt()).floor() as i32;
    }
    // 最宽的段先查；稳定排序，与 JS `Array.prototype.sort` 同序
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| ks[b].cmp(&ks[a]));
    let cap = (2 * rx + 1) as u16;
    let mut run_r = vec![0u16; w * h];
    for y in 0..h {
        let o = y * w;
        let mut r = 0u16;
        for x in (0..w).rev() {
            r = if data[o + x] != 0 { cap.min(r + 1) } else { 0 };
            run_r[o + x] = r;
        }
    }
    let (rxu, ryu) = (rx.max(0) as usize, ry.max(0) as usize);
    let mut out = vec![0u8; w * h];
    if h <= 2 * ryu || w <= 2 * rxu {
        return out;
    }
    let mut er = vec![0u8; w * h];
    for y in ryu..h - ryu {
        for x in rxu..w - rxu {
            if data[y * w + x] == 0 {
                continue;
            }
            let mut ok = true;
            for &i in &order {
                let k = ks[i];
                let idx = ((y as i64 + dys[i] as i64) * w as i64 + x as i64 - k as i64) as usize;
                if (run_r[idx] as i32) < 2 * k + 1 {
                    ok = false;
                    break;
                }
            }
            if ok {
                er[y * w + x] = 1;
            }
        }
    }
    for y in ryu..h - ryu {
        let o = y * w;
        let mut x = rxu;
        while x < w - rxu {
            if er[o + x] == 0 {
                x += 1;
                continue;
            }
            let mut b = x;
            while b + 1 < w && er[o + b + 1] != 0 {
                b += 1;
            }
            for i in 0..n {
                let t = y as i64 + dys[i] as i64;
                if t < 0 || t >= h as i64 {
                    continue;
                }
                let t = t as usize;
                let lo = (x as i64 - ks[i] as i64).max(0) as usize;
                let hi = (b + ks[i] as usize).min(w - 1) + 1;
                out[t * w + lo..t * w + hi].fill(1);
            }
            x = b + 1;
        }
    }
    out
}

/// 方形结构元 (2r+1)² 的膨胀（`dilate`）或腐蚀，就地写回。积分图按 i32 整型精确累加（同 TS 的 `Integral`）。
pub fn box_morph(data: &mut [u8], w: usize, h: usize, r: usize, dilate: bool) {
    let sw = w + 1;
    let mut s = vec![0i32; sw * (h + 1)];
    for y in 0..h {
        let mut run = 0i32;
        let (src, cur, up) = (y * w, (y + 1) * sw, y * sw);
        for x in 0..w {
            run += data[src + x] as i32;
            s[cur + x + 1] = s[up + x + 1] + run;
        }
    }
    let full = ((2 * r + 1) * (2 * r + 1)) as i32;
    for y in 0..h {
        let y0 = y.saturating_sub(r);
        let y1 = h.min(y + r + 1);
        for x in 0..w {
            let x0 = x.saturating_sub(r);
            let x1 = w.min(x + r + 1);
            let n = s[y1 * sw + x1] - s[y0 * sw + x1] - s[y1 * sw + x0] + s[y0 * sw + x0];
            let area = ((x1 - x0) * (y1 - y0)) as i32;
            data[y * w + x] = if dilate { (n > 0) as u8 } else { (n >= full.min(area)) as u8 };
        }
    }
}
