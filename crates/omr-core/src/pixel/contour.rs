//! 对应 `src/rasteromr/contour.ts` 的逐块特征（`countHoles`、`countPerim`）、整页找孔（`findHoles`）与孔的凸度（`holeSolidity`）。

/// 逐块的孔数、最大孔面积、周长。`boxes` 是 `[id, x, y, w, h] * n`，返回 `[holes, biggest, perim] * n`
/// （`holeFill = biggest / max(1, w·h)` 由 TS 照原式算）。
pub fn contour_features(labels: &[i32], w: usize, h: usize, boxes: &[i32]) -> Vec<i32> {
    let n = boxes.len() / 5;
    let mut out = Vec::with_capacity(n * 3);
    let mut blocked: Vec<u8> = Vec::new();
    let mut stack: Vec<u32> = Vec::new();
    for c in 0..n {
        let (id, bx, by, bw0, bh0) = (boxes[c * 5], boxes[c * 5 + 1] as usize, boxes[c * 5 + 2] as usize, boxes[c * 5 + 3] as usize, boxes[c * 5 + 4] as usize);
        // ── 孔：盒 + 一圈留白里，从边界够不着的背景团（小于 3 像素的不算）
        let (bw, bh) = (bw0 + 2, bh0 + 2);
        blocked.clear();
        blocked.resize(bw * bh, 0);
        for y in 1..bh - 1 {
            let row = (by + y - 1) * w + bx - 1;
            for x in 1..bw - 1 {
                if labels[row + x] == id {
                    blocked[y * bw + x] = 1;
                }
            }
        }
        let mut flood = |i: usize, blocked: &mut Vec<u8>| -> u32 {
            let mut size = 0u32;
            blocked[i] = 1;
            stack.clear();
            stack.push(i as u32);
            while let Some(cur) = stack.pop() {
                let cur = cur as usize;
                size += 1;
                let (y, x) = (cur / bw, cur % bw);
                if x + 1 < bw && blocked[cur + 1] == 0 {
                    blocked[cur + 1] = 1;
                    stack.push((cur + 1) as u32);
                }
                if x > 0 && blocked[cur - 1] == 0 {
                    blocked[cur - 1] = 1;
                    stack.push((cur - 1) as u32);
                }
                if y + 1 < bh && blocked[cur + bw] == 0 {
                    blocked[cur + bw] = 1;
                    stack.push((cur + bw) as u32);
                }
                if y > 0 && blocked[cur - bw] == 0 {
                    blocked[cur - bw] = 1;
                    stack.push((cur - bw) as u32);
                }
            }
            size
        };
        flood(0, &mut blocked);
        let (mut holes, mut biggest) = (0i32, 0i32);
        for y in 1..bh - 1 {
            for x in 1..bw - 1 {
                let i = y * bw + x;
                if blocked[i] != 0 {
                    continue;
                }
                let size = flood(i, &mut blocked) as i32;
                if size < 3 {
                    continue;
                }
                holes += 1;
                if size > biggest {
                    biggest = size;
                }
            }
        }
        // ── 周长：八邻域里有一个不是本块（或出图）就算边界
        let mut perim = 0i32;
        for y in by..by + bh0 {
            for x in bx..bx + bw0 {
                if labels[y * w + x] != id {
                    continue;
                }
                let mut edge = false;
                'nb: for dy in -1i64..=1 {
                    for dx in -1i64..=1 {
                        let (nx, ny) = (x as i64 + dx, y as i64 + dy);
                        if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 || labels[ny as usize * w + nx as usize] != id {
                            edge = true;
                            break 'nb;
                        }
                    }
                }
                if edge {
                    perim += 1;
                }
            }
        }
        out.extend_from_slice(&[holes, biggest, perim]);
    }
    out
}

/// 整页：从四边洪泛掉通到页外的背景，剩下的背景团（4 邻接）面积够 `min_area` 的就是孔。返回 `[x, y, w, h] * n`，按光栅序。
pub fn find_holes(data: &[u8], w: usize, h: usize, min_area: u32) -> Vec<i32> {
    let mut blocked: Vec<u8> = data.iter().map(|&v| (v != 0) as u8).collect();
    let mut stack: Vec<u32> = Vec::new();
    let push = |i: usize, blocked: &mut Vec<u8>, stack: &mut Vec<u32>| {
        if blocked[i] == 0 {
            blocked[i] = 1;
            stack.push(i as u32);
        }
    };
    let mut out = Vec::new();
    if w == 0 || h == 0 {
        return out;
    }
    for x in 0..w {
        push(x, &mut blocked, &mut stack);
        push((h - 1) * w + x, &mut blocked, &mut stack);
    }
    for y in 0..h {
        push(y * w, &mut blocked, &mut stack);
        push(y * w + w - 1, &mut blocked, &mut stack);
    }
    while let Some(cur) = stack.pop() {
        let cur = cur as usize;
        let (y, x) = (cur / w, cur % w);
        if x > 0 {
            push(cur - 1, &mut blocked, &mut stack);
        }
        if x + 1 < w {
            push(cur + 1, &mut blocked, &mut stack);
        }
        if y > 0 {
            push(cur - w, &mut blocked, &mut stack);
        }
        if y + 1 < h {
            push(cur + w, &mut blocked, &mut stack);
        }
    }
    for y0 in 0..h {
        for x0 in 0..w {
            let i = y0 * w + x0;
            if blocked[i] != 0 {
                continue;
            }
            let (mut min_x, mut max_x, mut min_y, mut max_y, mut area) = (x0, x0, y0, y0, 0u32);
            blocked[i] = 1;
            stack.push(i as u32);
            while let Some(cur) = stack.pop() {
                let cur = cur as usize;
                let (y, x) = (cur / w, cur % w);
                area += 1;
                min_x = min_x.min(x);
                max_x = max_x.max(x);
                min_y = min_y.min(y);
                max_y = max_y.max(y);
                if x > 0 {
                    push(cur - 1, &mut blocked, &mut stack);
                }
                if x + 1 < w {
                    push(cur + 1, &mut blocked, &mut stack);
                }
                if y > 0 {
                    push(cur - w, &mut blocked, &mut stack);
                }
                if y + 1 < h {
                    push(cur + w, &mut blocked, &mut stack);
                }
            }
            if area >= min_area {
                out.extend_from_slice(&[min_x as i32, min_y as i32, (max_x - min_x + 1) as i32, (max_y - min_y + 1) as i32]);
            }
        }
    }
    out
}

/// 孔的凸度：从盒里离盒心最近的白点洪泛（4 邻接），面积 / 逐行白段两端点的凸包面积。
pub fn hole_solidity(data: &[u8], w: usize, bx: usize, by: usize, bw: usize, bh: usize) -> f64 {
    let mut inn = vec![0u8; bw * bh];
    let mut seed: i64 = -1;
    let mut bd = f64::INFINITY;
    let (hw, hh) = (bw as f64 / 2.0, bh as f64 / 2.0);
    for y in by..by + bh {
        for x in bx..bx + bw {
            if data[y * w + x] != 0 {
                continue;
            }
            let (dx, dy) = ((x - bx) as f64 - hw, (y - by) as f64 - hh);
            let d = dx.powi(2) + dy.powi(2);
            if d < bd {
                bd = d;
                seed = ((y - by) * bw + x - bx) as i64;
            }
        }
    }
    if seed < 0 {
        return 0.0;
    }
    let mut stack: Vec<u32> = vec![seed as u32];
    inn[seed as usize] = 1;
    let mut area = 0u32;
    let open = |q: usize, xx: usize, yy: usize, inn: &Vec<u8>| inn[q] == 0 && data[(yy + by) * w + xx + bx] == 0;
    while let Some(k) = stack.pop() {
        let k = k as usize;
        area += 1;
        let (x, y) = (k % bw, k / bw);
        if x + 1 < bw && open(k + 1, x + 1, y, &inn) {
            inn[k + 1] = 1;
            stack.push((k + 1) as u32);
        }
        if x > 0 && open(k - 1, x - 1, y, &inn) {
            inn[k - 1] = 1;
            stack.push((k - 1) as u32);
        }
        if y + 1 < bh && open(k + bw, x, y + 1, &inn) {
            inn[k + bw] = 1;
            stack.push((k + bw) as u32);
        }
        if y > 0 && open(k - bw, x, y - 1, &inn) {
            inn[k - bw] = 1;
            stack.push((k - bw) as u32);
        }
    }
    let mut pts: Vec<(i64, i64)> = Vec::new();
    for y in 0..bh {
        let (mut l, mut r) = (-1i64, -1i64);
        for x in 0..bw {
            if inn[y * bw + x] != 0 {
                if l < 0 {
                    l = x as i64;
                }
                r = x as i64;
            }
        }
        if l >= 0 {
            let y = y as i64;
            pts.extend_from_slice(&[(l, y), (r + 1, y), (l, y + 1), (r + 1, y + 1)]);
        }
    }
    pts.sort();
    let cross = |o: (i64, i64), a: (i64, i64), c: (i64, i64)| (a.0 - o.0) * (c.1 - o.1) - (a.1 - o.1) * (c.0 - o.0);
    let mut lo: Vec<(i64, i64)> = Vec::new();
    for &p in &pts {
        while lo.len() >= 2 && cross(lo[lo.len() - 2], lo[lo.len() - 1], p) <= 0 {
            lo.pop();
        }
        lo.push(p);
    }
    let mut up: Vec<(i64, i64)> = Vec::new();
    for &p in pts.iter().rev() {
        while up.len() >= 2 && cross(up[up.len() - 2], up[up.len() - 1], p) <= 0 {
            up.pop();
        }
        up.push(p);
    }
    let mut hull: Vec<(i64, i64)> = lo[..lo.len().saturating_sub(1)].to_vec();
    hull.extend_from_slice(&up[..up.len().saturating_sub(1)]);
    let mut a2: i64 = 0;
    for i in 0..hull.len() {
        let (p, q) = (hull[i], hull[(i + 1) % hull.len()]);
        a2 += p.0 * q.1 - q.0 * p.1;
    }
    area as f64 / 1f64.max(a2.abs() as f64 / 2.0)
}
