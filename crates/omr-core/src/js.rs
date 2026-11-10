//! 与 TS 实现逐字相同要守的数值口径。移植的判据里凡是 `Math.round`、`| 0`、`Array.prototype.sort`
//! 都走这里，不直接用 Rust 的 `f64::round`（半数远离零）与 `as i32`（饱和）——两边在 x.5 的负数、越界值上不同。
use std::cmp::Ordering;

/// `Math.round`：半数向正无穷（`-2.5 → -2`、`2.5 → 3`）。
#[inline]
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    // 不写 floor(x + 0.5)：0.49999999999999994 + 0.5 进位成 1
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// `x | 0`：ToInt32（向零截断，按 2^32 回绕；NaN、无穷为 0）。
#[inline]
pub fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    let t = x.trunc();
    if t >= -2147483648.0 && t <= 2147483647.0 {
        return t as i32;
    }
    let m = t.rem_euclid(4294967296.0);
    (m as u64) as u32 as i32
}

/// `arr.sort((a, b) => cmp(a, b))`：稳定排序，比较函数回数值（负 / 零 / 正；NaN 当零）。
///
/// 自写归并而不用 `slice::sort_by`：比较函数不成全序时（判据里有按容差比的）标准库可能 panic。
/// 全序比较函数下结果与 V8 相同（都是稳定排序）；不成全序时结果依赖算法细节，移植到那种调用点要单独核对。
pub fn sort_by<T: Clone>(v: &mut [T], mut cmp: impl FnMut(&T, &T) -> f64) {
    let n = v.len();
    if n < 2 {
        return;
    }
    let mut buf: Vec<T> = v.to_vec();
    let mut width = 1;
    let mut src_is_v = true;
    while width < n {
        {
            let (src, dst): (&[T], &mut [T]) = if src_is_v { (&*v, &mut buf[..]) } else { (&buf[..], &mut *v) };
            let mut lo = 0;
            while lo < n {
                let mid = (lo + width).min(n);
                let hi = (lo + 2 * width).min(n);
                let (mut i, mut j, mut k) = (lo, mid, lo);
                while i < mid && j < hi {
                    // 右边严格小才先出，相等保左边在前
                    if cmp(&src[j], &src[i]) < 0.0 {
                        dst[k] = src[j].clone();
                        j += 1;
                    } else {
                        dst[k] = src[i].clone();
                        i += 1;
                    }
                    k += 1;
                }
                while i < mid {
                    dst[k] = src[i].clone();
                    i += 1;
                    k += 1;
                }
                while j < hi {
                    dst[k] = src[j].clone();
                    j += 1;
                    k += 1;
                }
                lo = hi;
            }
        }
        src_is_v = !src_is_v;
        width *= 2;
    }
    if !src_is_v {
        v.clone_from_slice(&buf);
    }
}

/// 数值升序（`(a, b) => a - b`）。
pub fn sort_num(v: &mut [f64]) {
    sort_by(v, |a, b| a - b);
}

/// 比较函数回值 → `Ordering`（给确知是全序的地方配 `sort_by` 用）。
#[inline]
pub fn ordering(d: f64) -> Ordering {
    if d < 0.0 {
        Ordering::Less
    } else if d > 0.0 {
        Ordering::Greater
    } else {
        Ordering::Equal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_like_js() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(-0.4), -0.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(1e20), 1e20);
        assert!(round(f64::NAN).is_nan());
    }

    #[test]
    fn to_int32_like_js() {
        assert_eq!(to_int32(3.9), 3);
        assert_eq!(to_int32(-3.9), -3);
        assert_eq!(to_int32(2147483648.0), -2147483648);
        assert_eq!(to_int32(4294967296.0 + 5.0), 5);
        assert_eq!(to_int32(-1.0), -1);
        assert_eq!(to_int32(f64::NAN), 0);
    }

    #[test]
    fn sort_is_stable() {
        let mut v: Vec<(i32, usize)> = [3, 1, 2, 1, 3, 2, 1, 0, 5].iter().enumerate().map(|(i, &k)| (k, i)).collect();
        sort_by(&mut v, |a, b| (a.0 - b.0) as f64);
        assert_eq!(v, vec![(0, 7), (1, 1), (1, 3), (1, 6), (2, 2), (2, 5), (3, 0), (3, 4), (5, 8)]);
        let mut e: Vec<f64> = vec![];
        sort_num(&mut e);
        let mut w = vec![2.0, f64::NAN, 1.0];
        sort_num(&mut w); // 不 panic 即可
        assert_eq!(w.len(), 3);
    }
}
