//! 声部指派与谱号 / 调号沿用：各系统的行配到哪个声部、全曲的调号与谱号读数顺着乐曲定下来。
use super::*;

/// 行数少的系统的各行配到哪几个声部：保序，谱号不同的罚一分，并列取靠下的。
pub(super) fn assign(clefs: &[Option<Clef>], slots: &[Option<Clef>]) -> Vec<usize> {
    let (n, m) = (clefs.len(), slots.len());
    if n >= m {
        return (0..n).map(|i| i.min(m.saturating_sub(1))).collect();
    }
    // best[i][j]：第 i 行配声部 j 时前 i 行的最小罚分
    let cost = |i: usize, j: usize| match (clefs[i], slots[j]) {
        (Some(a), Some(b)) if a.sign != b.sign => 2,
        (Some(a), Some(b)) if a != b => 1,
        _ => 0,
    };
    let mut best = vec![vec![u32::MAX; m]; n];
    for j in 0..m {
        best[0][j] = cost(0, j);
    }
    for i in 1..n {
        for j in i..m {
            let prev = (i - 1..j).map(|k| best[i - 1][k]).min().unwrap_or(u32::MAX);
            if prev != u32::MAX {
                best[i][j] = prev + cost(i, j);
            }
        }
    }
    let mut out = vec![0; n];
    let mut hi = m;
    for i in (0..n).rev() {
        let lo = i;
        let j = (lo..hi).rev().min_by_key(|&j| best[i][j]).unwrap();
        out[i] = j;
        hi = j;
    }
    out
}

/// 各系统的调号读数（同系统互证过的）顺着乐曲定下来：没读出的沿用；孤零零一个系统与前后都不同的照前后改；
/// 收得不干净（后面还跟着像升降号的墨）又比邻近系统少几个同种记号的，照邻近的补——少读常见，转调少见且前后系统会一致。
pub(super) fn settle_keys(read: &[Option<(i8, bool)>]) -> Vec<i8> {
    settle(read, |a, b| a.unsigned_abs() < b.unsigned_abs() && (a == 0 || (a > 0) == (b > 0))).into_iter().map(|v| v.unwrap_or(0)).collect()
}

/// 一串按乐曲次序的读数（值, 把握大）定下来：没读出的沿用前一个（开头的取后面第一个）；一段读数夹在两段相同的读数之间、
/// 自己又只有一个或没把握的，照两边改；没把握又是邻段「少读」（`prefix(本段, 邻段)`）的照邻段补；开头结尾孤零零一个没把握的照邻段改。
pub(super) fn settle<T: Copy + PartialEq>(read: &[Option<(T, bool)>], prefix: impl Fn(T, T) -> bool) -> Vec<Option<T>> {
    let n = read.len();
    let mut k: Vec<Option<T>> = read.iter().map(|r| r.map(|x| x.0)).collect();
    let sure: Vec<bool> = read.iter().map(|r| r.is_some_and(|x| x.1)).collect();
    for i in 1..n {
        if k[i].is_none() {
            k[i] = k[i - 1];
        }
    }
    for i in (0..n.saturating_sub(1)).rev() {
        if k[i].is_none() {
            k[i] = k[i + 1];
        }
    }
    if k.iter().any(|v| v.is_none()) {
        return k;
    }
    let mut k: Vec<T> = k.into_iter().map(|v| v.unwrap()).collect();
    for _ in 0..4 {
        let mut changed = false;
        let mut i = 0;
        while i < n {
            let mut j = i;
            while j + 1 < n && k[j + 1] == k[i] {
                j += 1;
            }
            let prev = (i > 0).then(|| k[i - 1]);
            let next = (j + 1 < n).then(|| k[j + 1]);
            let unsure = (i..=j).all(|t| !sure[t]);
            let single = i == j;
            let to = match (prev, next) {
                (Some(p), Some(q)) if p == q && (single || unsure) => Some(p),
                (Some(p), _) if unsure && prefix(k[i], p) => Some(p),
                (_, Some(q)) if unsure && prefix(k[i], q) => Some(q),
                (Some(p), None) if single && unsure => Some(p),
                (None, Some(q)) if single && unsure => Some(q),
                _ => None,
            };
            if let Some(v) = to {
                for t in i..=j {
                    k[t] = v;
                }
                changed = true;
            }
            i = j + 1;
        }
        if !changed {
            break;
        }
    }
    k.into_iter().map(Some).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fewer_rows_go_to_matching_clefs_bottom_first() {
        let (g, f) = (Some(Clef::TREBLE), Some(Clef::BASS));
        assert_eq!(assign(&[g, f], &[g, g, f, g, f]), vec![3, 4]);
        assert_eq!(assign(&[g, g, f], &[g, g, f, g, f]), vec![1, 3, 4]);
        assert_eq!(assign(&[g, f, g], &[g, f, g]), vec![0, 1, 2]);
    }
}

#[cfg(test)]
mod key_tests {
    use super::settle_keys;

    #[test]
    fn underread_rows_follow_neighbours() {
        // 孤零零一个系统少读
        assert_eq!(settle_keys(&[Some((-3, true)), Some((-2, true)), Some((-3, true))]), vec![-3, -3, -3]);
        // 开头两个系统收得不干净、少读一个
        assert_eq!(settle_keys(&[Some((-1, false)), Some((-1, false)), Some((-2, true))]), vec![-2, -2, -2]);
        // 真转调：前后各成一段、都收得干净
        assert_eq!(settle_keys(&[Some((-1, true)), Some((-1, true)), Some((2, true)), Some((2, true))]), vec![-1, -1, 2, 2]);
        // 没读出的沿用
        assert_eq!(settle_keys(&[None, Some((1, true)), None]), vec![1, 1, 1]);
    }
}
