//! 对应 `src/rasteromr/descreen.ts` 的 `halftoneRatio`、`pinholeRatio`、`dropSpecks` 与 `src/rasteromr/rasterpage.ts` 的 `mergeHorizontal`。
//! 取图时整页逐像素量网点、针孔、孤点与补淡谱线；判据（门槛、取舍）留在 TS，这里只数数、只按给定参数改像素。

/// 孤立墨点数与墨点数：3×3 窗口（越界截掉）里墨不过 3 个（含自己）算孤立。
/// `rows` 长 h（非零 = 量这一行），空切片 = 全量；`on_line` 长 w×h（非零 = 压在谱线上，孤立也不计），空切片 = 都不算。
pub fn halftone_counts(data: &[u8], w: usize, h: usize, rows: &[u8], on_line: &[u8]) -> (u64, u64) {
    let (mut ink, mut lone) = (0u64, 0u64);
    for y in 0..h {
        if !rows.is_empty() && rows[y] == 0 {
            continue;
        }
        let y0 = y.saturating_sub(1);
        let y1 = (y + 2).min(h);
        for x in 0..w {
            if data[y * w + x] == 0 {
                continue;
            }
            ink += 1;
            let x0 = x.saturating_sub(1);
            let x1 = (x + 2).min(w);
            let mut n = 0u32;
            for yy in y0..y1 {
                let row = yy * w;
                for xx in x0..x1 {
                    n += data[row + xx] as u32;
                }
            }
            if n <= 3 && (on_line.is_empty() || on_line[y * w + x] == 0) {
                lone += 1;
            }
        }
    }
    (ink, lone)
}

/// 墨点数与针孔数（八邻域至少六个是墨的白点），只看 1..h-1 × 1..w-1；`rows` 同上。
pub fn pinhole_counts(data: &[u8], w: usize, h: usize, rows: &[u8]) -> (u64, u64) {
    let (mut ink, mut holes) = (0u64, 0u64);
    if w < 3 || h < 3 {
        return (0, 0);
    }
    for y in 1..h - 1 {
        if !rows.is_empty() && rows[y] == 0 {
            continue;
        }
        for x in 1..w - 1 {
            let i = y * w + x;
            if data[i] != 0 {
                ink += 1;
                continue;
            }
            let n = data[i - w - 1] as u32 + data[i - w] as u32 + data[i - w + 1] as u32 + data[i - 1] as u32 + data[i + 1] as u32
                + data[i + w - 1] as u32
                + data[i + w] as u32
                + data[i + w + 1] as u32;
            if n >= 6 {
                holes += 1;
            }
        }
    }
    (ink, holes)
}

fn isolated(data: &[u8], w: usize, x: usize, y: usize) -> bool {
    for dy in 0..3 {
        for dx in 0..3 {
            if (dx != 1 || dy != 1) && data[(y + dy - 1) * w + x + dx - 1] != 0 {
                return false;
            }
        }
    }
    true
}

/// 孤点过密的块（`tile` 见方，孤点数 ≥ `min`）连同四邻块里，抹掉孤立的单像素墨点（就地改）。返回过密的块数。
/// 块计数照 TS 用 u16（`Uint16Array`，溢出回绕）。
pub fn drop_specks(data: &mut [u8], w: usize, h: usize, min: u32, tile: usize) -> u32 {
    let cols = w.div_ceil(tile);
    let rows = h.div_ceil(tile);
    let mut count = vec![0u16; cols * rows];
    if w >= 3 && h >= 3 {
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                if data[y * w + x] != 0 && isolated(data, w, x, y) {
                    let k = (y / tile) * cols + x / tile;
                    count[k] = count[k].wrapping_add(1);
                }
            }
        }
    }
    let mut hot = vec![0u8; cols * rows];
    let mut n = 0u32;
    for r in 0..rows {
        for c in 0..cols {
            if (count[r * cols + c] as u32) < min {
                continue;
            }
            n += 1;
            for dr in -1i64..=1 {
                for dc in -1i64..=1 {
                    let (rr, cc) = (r as i64 + dr, c as i64 + dc);
                    if rr >= 0 && cc >= 0 && (rr as usize) < rows && (cc as usize) < cols {
                        hot[rr as usize * cols + cc as usize] = 1;
                    }
                }
            }
        }
    }
    if n == 0 || w < 3 || h < 3 {
        return n;
    }
    let mut kill: Vec<usize> = Vec::new();
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            if hot[(y / tile) * cols + x / tile] != 0 && data[y * w + x] != 0 && isolated(data, w, x, y) {
                kill.push(y * w + x);
            }
        }
    }
    for i in kill {
        data[i] = 0;
    }
    n
}

/// 松阈值图 `soft` 里细（纵向厚不过 `max_thick`）而长（不短于 `min_run`）的横向游程，
/// 补进原图上下 `gap_tol` 内没有墨的列（就地改 `bin`；判断都按改之前的 `bin`）。
pub fn merge_horizontal(bin: &mut [u8], soft: &[u8], w: usize, h: usize, min_run: usize, max_thick: usize, gap_tol: i64) {
    let thin = |x: usize, y: usize| -> bool {
        let (mut a, mut b) = (y, y);
        while a > 0 && soft[(a - 1) * w + x] != 0 && y - a < max_thick {
            a -= 1;
        }
        while b + 1 < h && soft[(b + 1) * w + x] != 0 && b - y < max_thick {
            b += 1;
        }
        b - a + 1 <= max_thick
    };
    let mut fill: Vec<usize> = Vec::new();
    for y in 0..h {
        let mut x = 0usize;
        while x < w {
            if soft[y * w + x] == 0 || !thin(x, y) {
                x += 1;
                continue;
            }
            let mut e = x;
            while e + 1 < w && soft[y * w + e + 1] != 0 && thin(e + 1, y) {
                e += 1;
            }
            if e - x + 1 >= min_run {
                for k in x..=e {
                    let mut has = false;
                    let mut d = -gap_tol;
                    while d <= gap_tol && !has {
                        let yy = y as i64 + d;
                        if yy >= 0 && (yy as usize) < h && bin[yy as usize * w + k] != 0 {
                            has = true;
                        }
                        d += 1;
                    }
                    if !has {
                        fill.push(y * w + k);
                    }
                }
            }
            x = e + 1;
        }
    }
    for i in fill {
        bin[i] = 1;
    }
}
