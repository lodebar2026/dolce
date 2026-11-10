//! 几何与统计小工具，逐项对应 `src/omrkit/geom.ts`（口径见那边的注释，别合并「看似重复」的几种）。
use crate::image::{Binary, Rect};
use crate::js;

/// 中位数，偏上取（偶数个取右中，`s[len >> 1]`）；空序列回 `fallback`。
pub fn median(xs: &[f64], fallback: f64) -> f64 {
    if xs.is_empty() {
        return fallback;
    }
    let mut s = xs.to_vec();
    js::sort_num(&mut s);
    s[s.len() >> 1]
}

/// `p` 分位：排序后取下标 `min(n-1, floor(n*p))`；空序列回 0。
pub fn quantile(xs: &[f64], p: f64) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let mut a = xs.to_vec();
    js::sort_num(&mut a);
    let i = ((a.len() as f64) * p).floor();
    a[(i.max(0.0) as usize).min(a.len() - 1)]
}

/// 均值，跳过 NaN；一个有效值都没有回 NaN。
pub fn mean_finite(xs: &[f64]) -> f64 {
    let (mut s, mut n) = (0.0, 0usize);
    for &y in xs {
        if !y.is_nan() {
            s += y;
            n += 1;
        }
    }
    if n > 0 {
        s / n as f64
    } else {
        f64::NAN
    }
}

/// 一维区间重叠长度（不重叠为 0）。
#[inline]
pub fn overlap1d(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    (a1.min(b1) - a0.max(b0)).max(0.0)
}

/// 第 `y` 行在 `[xa, xb]`（含两端）里有没有墨；`y` 出图算没有，x 由调用方保证在图内。
pub fn row_has_ink(bin: &Binary, y: i64, xa: i64, xb: i64) -> bool {
    if y < 0 || y as usize >= bin.h {
        return false;
    }
    let o = y as usize * bin.w;
    (xa..=xb).any(|x| bin.data[o + x as usize] != 0)
}

pub fn union_rect(a: &Rect, b: &Rect) -> Rect {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    Rect { x, y, w: a.right().max(b.right()) - x, h: a.bottom().max(b.bottom()) - y }
}

/// 一组包围盒的并；空的回全 0。
pub fn union_rects(rs: &[Rect]) -> Rect {
    let mut it = rs.iter();
    match it.next() {
        None => Rect::default(),
        Some(first) => it.fold(*first, |acc, r| union_rect(&acc, r)),
    }
}

/// x 向重叠的长度。
pub fn overlap_x(a: &Rect, b: &Rect) -> f64 {
    overlap1d(a.x, a.right(), b.x, b.right())
}

/// x 向重叠占较窄那个宽度的比例。
pub fn overlap_ratio_x(a: &Rect, b: &Rect) -> f64 {
    overlap_x(a, b) / a.w.min(b.w)
}

/// y 向重叠占较矮那个高度的比例。
pub fn overlap_ratio_y(a: &Rect, b: &Rect) -> f64 {
    (a.bottom().min(b.bottom()) - a.y.max(b.y)).max(0.0) / a.h.min(b.h)
}

/// 重叠面积占 **a** 的比例（非对称）。
pub fn overlap_frac(a: &Rect, b: &Rect) -> f64 {
    let w = a.right().min(b.right()) - a.x.max(b.x);
    let h = a.bottom().min(b.bottom()) - a.y.max(b.y);
    if w > 0.0 && h > 0.0 {
        (w * h) / (a.w * a.h).max(1.0)
    } else {
        0.0
    }
}

/// 按纵向中心贪心聚成行：按键升序扫，落进「行内键的中位数与它相差 < tol」的第一行，否则另起一行。
/// 回各行里元素在 `items` 中的下标。`tol` 由调用方给（各处容差语义不同）。
pub fn cluster_by_y<T>(items: &[T], key_of: impl Fn(&T) -> f64, tol: f64) -> Vec<Vec<usize>> {
    let keys: Vec<f64> = items.iter().map(&key_of).collect();
    let mut order: Vec<usize> = (0..items.len()).collect();
    js::sort_by(&mut order, |&a, &b| keys[a] - keys[b]);
    let mut lines: Vec<Vec<usize>> = Vec::new();
    for i in order {
        match find_line_by_y(&lines, &keys, keys[i], tol) {
            Some(k) => lines[k].push(i),
            None => lines.push(vec![i]),
        }
    }
    lines
}

/// 只找已有的行、不新建：回第一条「行内键的中位数与 `y` 相差 < tol」的行号。
pub fn find_line_by_y(lines: &[Vec<usize>], keys: &[f64], y: f64, tol: f64) -> Option<usize> {
    lines.iter().position(|l| {
        let ks: Vec<f64> = l.iter().map(|&j| keys[j]).collect();
        (median(&ks, 0.0) - y).abs() < tol
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stats() {
        assert_eq!(median(&[4.0, 1.0, 3.0, 2.0], 0.0), 3.0);
        assert_eq!(median(&[], 7.0), 7.0);
        assert_eq!(quantile(&[1.0, 2.0, 3.0, 4.0], 0.5), 3.0);
        assert_eq!(quantile(&[1.0, 2.0, 3.0, 4.0], 1.0), 4.0);
        assert_eq!(mean_finite(&[1.0, f64::NAN, 3.0]), 2.0);
        assert!(mean_finite(&[f64::NAN]).is_nan());
    }

    #[test]
    fn rects() {
        let a = Rect::new(0.0, 0.0, 10.0, 10.0);
        let b = Rect::new(5.0, 5.0, 10.0, 2.0);
        assert_eq!(union_rect(&a, &b), Rect::new(0.0, 0.0, 15.0, 10.0));
        assert_eq!(overlap_x(&a, &b), 5.0);
        assert_eq!(overlap_ratio_y(&a, &b), 1.0);
        assert_eq!(overlap_frac(&a, &b), 0.1);
        assert_eq!(overlap_frac(&b, &a), 0.5);
        assert_eq!(union_rects(&[]), Rect::default());
    }

    #[test]
    fn cluster() {
        let ys = [10.0, 50.0, 11.0, 52.0, 9.0];
        let lines = cluster_by_y(&ys, |&y| y, 5.0);
        assert_eq!(lines, vec![vec![4, 0, 2], vec![1, 3]]);
    }
}
