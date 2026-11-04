//! 对应 `src/omrkit/ccl.ts::connectedComponents`：墨（值为 1）的 8 邻接块，按行游程并查集。
//! 块号照「块首像素的光栅序」发（并查集总挂到小号上，根就是块里光栅序最早的那段），与 TS 一致。

/// 返回扁平块表 `[id, x, y, w, h, area, cx, cy] * n`；`labels` 写标号图（0 = 背景，块号 = 下标 + 1）。
/// 面积、质心按 f64 照 TS 的累加次序算，结果逐位相同。
pub fn connected_components(data: &[u8], w: usize, h: usize, min_area: f64, labels: &mut [i32]) -> Vec<f64> {
    labels.fill(0);
    let mut ry: Vec<u32> = Vec::new();
    let mut rx0: Vec<u32> = Vec::new();
    let mut rx1: Vec<u32> = Vec::new();
    let mut parent: Vec<u32> = Vec::new();
    fn find(parent: &mut [u32], mut a: u32) -> u32 {
        while parent[a as usize] != a {
            let g = parent[parent[a as usize] as usize];
            parent[a as usize] = g;
            a = g;
        }
        a
    }
    let (mut prev_start, mut prev_end) = (0usize, 0usize);
    for y in 0..h {
        let o = y * w;
        let cur_start = ry.len();
        let mut j = prev_start;
        let mut x = 0usize;
        while x < w {
            if data[o + x] != 1 {
                x += 1;
                continue;
            }
            let a = x;
            while x < w && data[o + x] == 1 {
                x += 1;
            }
            let b = x - 1;
            let id = ry.len() as u32;
            ry.push(y as u32);
            rx0.push(a as u32);
            rx1.push(b as u32);
            parent.push(id);
            while j < prev_end && (rx1[j] as i64) < a as i64 - 1 {
                j += 1;
            }
            let mut k = j;
            while k < prev_end && rx0[k] as usize <= b + 1 {
                let ra = find(&mut parent, k as u32);
                let rb = find(&mut parent, id);
                if ra != rb {
                    parent[ra.max(rb) as usize] = ra.min(rb);
                }
                k += 1;
            }
        }
        prev_start = cur_start;
        prev_end = ry.len();
    }
    let n = ry.len();
    let mut label = vec![0u32; n];
    let (mut area, mut sx, mut sy) = (Vec::<f64>::new(), Vec::<f64>::new(), Vec::<f64>::new());
    let (mut min_x, mut max_x, mut min_y, mut max_y) = (Vec::<u32>::new(), Vec::<u32>::new(), Vec::<u32>::new(), Vec::<u32>::new());
    let mut next = 0u32;
    for i in 0..n {
        let r = find(&mut parent, i as u32);
        let c = if r as usize == i {
            let c = next;
            next += 1;
            area.push(0.0);
            sx.push(0.0);
            sy.push(0.0);
            min_x.push(w as u32);
            max_x.push(0);
            min_y.push(ry[i]);
            max_y.push(0);
            c
        } else {
            label[r as usize]
        };
        label[i] = c;
        let ci = c as usize;
        let (a, b) = (rx0[i], rx1[i]);
        let len = (b - a + 1) as f64;
        area[ci] += len;
        sx[ci] += ((a + b) as f64 * len) / 2.0;
        sy[ci] += ry[i] as f64 * len;
        if a < min_x[ci] {
            min_x[ci] = a;
        }
        if b > max_x[ci] {
            max_x[ci] = b;
        }
        if ry[i] > max_y[ci] {
            max_y[ci] = ry[i];
        }
        let row = ry[i] as usize * w;
        labels[row + a as usize..row + b as usize + 1].fill(c as i32 + 1);
    }
    let mut out = Vec::new();
    for c in 0..next as usize {
        if area[c] < min_area {
            continue;
        }
        out.extend_from_slice(&[
            (c + 1) as f64,
            min_x[c] as f64,
            min_y[c] as f64,
            (max_x[c] - min_x[c] + 1) as f64,
            (max_y[c] - min_y[c] + 1) as f64,
            area[c],
            sx[c] / area[c],
            sy[c] / area[c],
        ]);
    }
    out
}
