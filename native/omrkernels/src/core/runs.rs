//! 对应 `src/rasteromr/prims.ts` 的 `runLengths`（逐像素所在墨游程的长度）。
//! `close1d` 试过移植：TS 本身就是一趟扫描，原生版还多一次返回新数组的拷贝，实测不快（干净 1.06 → 1.07 s、扫描 2.39 → 2.64 s），撤了。

/// `vertical` 沿列量，否则沿行量；判墨按非零（同 TS 的真值判断）。
pub fn run_lengths(data: &[u8], w: usize, h: usize, vertical: bool) -> Vec<u16> {
    let mut out = vec![0u16; w * h];
    let (lines, len, step) = if vertical { (w, h, w) } else { (h, w, 1) };
    for l in 0..lines {
        let base = if vertical { l } else { l * w };
        let mut i = 0usize;
        while i < len {
            if data[base + i * step] == 0 {
                i += 1;
                continue;
            }
            let mut i2 = i;
            while i2 + 1 < len && data[base + (i2 + 1) * step] != 0 {
                i2 += 1;
            }
            let n = (i2 - i + 1) as u16;
            for k in i..=i2 {
                out[base + k * step] = n;
            }
            i = i2 + 1;
        }
    }
    out
}
