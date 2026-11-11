//! 细长笔画（两条路线共用）：弧、松叶的边、房子横线、连音括线都先取成「逐列只有一段墨」的笔画，再各按形状分。
//!
//! 这里只有几何：从一张「细墨」掩膜（纵向墨段不厚的像素，由调用方按自己的墨层给）逐列追踪成笔画、
//! 断口两侧按走向拼接、量拱高与直不直。哪些像素算细墨、断口里能不能过（谱线、符干）由调用方定。

/// 一条细长笔画：从 `x0` 起每列一段墨 `(上沿, 下沿)`（含）。拼接时跨过的断口按两端连线补上。
#[derive(Clone, Debug, PartialEq)]
pub struct Stroke {
    pub x0: i64,
    pub cols: Vec<(i32, i32)>,
}

/// 笔画相对两端连线的形状。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shape {
    /// 两端（最外一小截的中位）`(x, y)`。
    pub a: (f64, f64),
    pub b: (f64, f64),
    /// 中线离两端连线最远处：往上（y 小的一侧）、往下各多少（都不为负）。
    pub up: f64,
    pub down: f64,
    /// 最远处在笔画的什么位置（0~1）。
    pub peak: f64,
    /// 各列墨厚的中位数。
    pub thick: f64,
}

impl Shape {
    /// 拱高（朝拱的那一侧）与是否朝上拱。
    pub fn arch(&self) -> (f64, bool) {
        if self.up >= self.down { (self.up, true) } else { (self.down, false) }
    }
    /// 背面（不朝拱的那一侧）鼓出多少。
    pub fn back(&self) -> f64 {
        self.up.min(self.down)
    }
    /// 两端连线的斜率（y 朝下）。
    pub fn slope(&self) -> f64 {
        (self.b.1 - self.a.1) / (self.b.0 - self.a.0).max(1.0)
    }
}

impl Stroke {
    pub fn x1(&self) -> i64 {
        self.x0 + self.cols.len() as i64 - 1
    }
    pub fn width(&self) -> f64 {
        self.cols.len() as f64
    }
    /// x 处的中线 y（x 要在笔画范围内）。
    pub fn mid(&self, x: i64) -> f64 {
        let (a, b) = self.cols[(x - self.x0) as usize];
        (a + b) as f64 / 2.0
    }
    pub fn top(&self) -> i32 {
        self.cols.iter().map(|c| c.0).min().unwrap_or(0)
    }
    pub fn bottom(&self) -> i32 {
        self.cols.iter().map(|c| c.1).max().unwrap_or(0)
    }

    /// 一端最外一小截（宽的三十分之一，至少一列）中线的中位——弧的两头是尖的，往里多取会被拉向弧背。
    fn end_y(&self, left: bool) -> f64 {
        let n = (self.cols.len() / 30).max(1);
        let mut v: Vec<f64> = (0..n).map(|i| if left { i } else { self.cols.len() - 1 - i }).map(|i| (self.cols[i].0 + self.cols[i].1) as f64 / 2.0).collect();
        v.sort_by(f64::total_cmp);
        v[v.len() / 2]
    }

    /// 一端的走向：最外 `span` 列中线的首末连线斜率。
    pub fn end_slope(&self, left: bool, span: usize) -> f64 {
        let n = self.cols.len();
        let k = span.clamp(2, n.max(2)).min(n);
        if k < 2 {
            return 0.0;
        }
        let (i, j) = if left { (0, k - 1) } else { (n - k, n - 1) };
        let y = |i: usize| (self.cols[i].0 + self.cols[i].1) as f64 / 2.0;
        (y(j) - y(i)) / (j - i) as f64
    }

    pub fn shape(&self) -> Shape {
        let a = (self.x0 as f64, self.end_y(true));
        let b = (self.x1() as f64, self.end_y(false));
        let n = self.cols.len();
        let t_of = |i: usize| if n > 1 { i as f64 / (n - 1) as f64 } else { 0.0 };
        let dev: Vec<f64> = self.cols.iter().enumerate().map(|(i, c)| a.1 + (b.1 - a.1) * t_of(i) - (c.0 + c.1) as f64 / 2.0).collect();
        let up = dev.iter().fold(0.0f64, |m, &d| m.max(d));
        let down = dev.iter().fold(0.0f64, |m, &d| m.max(-d));
        // 最远处常是平的一段（像素取整）：取离最远不到一像素的那些列的正中
        let far = up.max(down);
        let near: Vec<usize> = (0..n).filter(|&i| dev[i].abs() >= far - 1.0).collect();
        let peak = (t_of(near[0]) + t_of(near[near.len() - 1])) / 2.0;
        let mut th: Vec<i32> = self.cols.iter().map(|c| c.1 - c.0 + 1).collect();
        th.sort_unstable();
        Shape { a, b, up, down, peak, thick: th[th.len() / 2] as f64 }
    }

    /// 接上右边的 `other`（中间的断口按两端连线补，墨厚取两端的平均）。
    pub fn join(&mut self, other: &Stroke) {
        let gap = other.x0 - self.x1() - 1;
        if gap > 0 {
            let (p, q) = (*self.cols.last().unwrap(), other.cols[0]);
            for g in 1..=gap {
                let t = g as f64 / (gap + 1) as f64;
                let lerp = |a: i32, b: i32| (a as f64 + (b - a) as f64 * t).round() as i32;
                self.cols.push((lerp(p.0, q.0), lerp(p.1, q.1)));
            }
        }
        let skip = (self.x1() + 1 - other.x0).max(0) as usize;
        self.cols.extend(other.cols.iter().skip(skip));
    }
}

/// 从细墨掩膜（`w × h`，非 0 为细墨）追踪笔画：相邻两列的墨段上下挨着（8 邻接）且一对一的连成一条；
/// 一分为二、合二为一的地方（松叶的尖、笔画交叉）各自断开另起。只留不窄于 `min_w` 列的。
pub fn trace(mask: &[u8], w: usize, h: usize, min_w: usize) -> Vec<Stroke> {
    let mut open: Vec<Stroke> = Vec::new();
    let mut done: Vec<Stroke> = Vec::new();
    let mut runs: Vec<(i32, i32)> = Vec::new();
    for x in 0..w {
        runs.clear();
        let mut y = 0;
        while y < h {
            if mask[y * w + x] == 0 {
                y += 1;
                continue;
            }
            let a = y;
            while y < h && mask[y * w + x] != 0 {
                y += 1;
            }
            runs.push((a as i32, y as i32 - 1));
        }
        let touch = |s: &Stroke, r: &(i32, i32)| {
            let l = s.cols.last().unwrap();
            r.0 <= l.1 + 1 && r.1 >= l.0 - 1
        };
        // 每段墨挨着几条笔画、每条笔画挨着几段墨
        let of_run: Vec<usize> = runs.iter().map(|r| open.iter().filter(|s| touch(s, r)).count()).collect();
        let of_open: Vec<usize> = open.iter().map(|s| runs.iter().filter(|r| touch(s, r)).count()).collect();
        let mut next: Vec<Stroke> = Vec::new();
        let mut taken = vec![false; runs.len()];
        for (si, s) in open.drain(..).enumerate() {
            let hit = if of_open[si] == 1 { runs.iter().position(|r| touch(&s, r)).filter(|&ri| of_run[ri] == 1) } else { None };
            match hit {
                Some(ri) => {
                    let mut s = s;
                    s.cols.push(runs[ri]);
                    taken[ri] = true;
                    next.push(s);
                }
                None => done.push(s),
            }
        }
        for (ri, r) in runs.iter().enumerate() {
            if !taken[ri] {
                next.push(Stroke { x0: x as i64, cols: vec![*r] });
            }
        }
        open = next;
    }
    done.extend(open);
    done.retain(|s| s.cols.len() >= min_w);
    done.sort_by(|a, b| a.x0.cmp(&b.x0).then(a.cols[0].0.cmp(&b.cols[0].0)));
    done
}

/// 拼接的门槛（像素）。
#[derive(Clone, Copy, Debug)]
pub struct JoinTol {
    /// 断口最宽多少列。
    pub max_gap: i64,
    /// 顺着左边那条的走向延到右边那条的起点，纵向差不过 `dy + dy_per_gap × 断口宽`。
    pub dy: f64,
    pub dy_per_gap: f64,
    /// 量走向取末端多少列。
    pub span: usize,
}

/// 把断开的笔画从左到右接起来：右边那条的起点落在左边那条走向的延长线附近、断口不过宽、且 `passable(左, 右)` 认可
/// （调用方回原图看断口里是什么：谱线、符干可以过，空白与别的墨不行）。一条左笔画有几条可接的取纵向差最小的。
pub fn join_all(mut strokes: Vec<Stroke>, tol: JoinTol, passable: &dyn Fn(&Stroke, &Stroke) -> bool) -> Vec<Stroke> {
    strokes.sort_by(|a, b| a.x0.cmp(&b.x0));
    let mut used = vec![false; strokes.len()];
    let mut out = Vec::new();
    for i in 0..strokes.len() {
        if used[i] {
            continue;
        }
        used[i] = true;
        let mut cur = strokes[i].clone();
        loop {
            let (x1, y1) = (cur.x1(), cur.mid(cur.x1()));
            let k = cur.end_slope(false, tol.span);
            let mut best: Option<(usize, f64)> = None;
            for (j, s) in strokes.iter().enumerate().skip(i + 1) {
                let gap = s.x0 - x1 - 1;
                if gap > tol.max_gap {
                    break;
                }
                if used[j] || gap < 0 {
                    continue;
                }
                let d = (s.mid(s.x0) - (y1 + k * (gap + 1) as f64)).abs();
                if d <= tol.dy + tol.dy_per_gap * gap as f64 && best.is_none_or(|b| d < b.1) && passable(&cur, s) {
                    best = Some((j, d));
                }
            }
            let Some((j, _)) = best else { break };
            used[j] = true;
            cur.join(&strokes[j]);
        }
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paint(mask: &mut [u8], w: usize, x: usize, y: usize) {
        mask[y * w + x] = 1;
    }

    #[test]
    fn arch_traced_and_measured() {
        let (w, h) = (120, 60);
        let mut m = vec![0u8; w * h];
        // 朝上拱的弧：两端 y=40，正中 y=30
        for x in 10..110 {
            let t = (x as f64 - 60.0) / 50.0;
            let y = (30.0 + 10.0 * t * t).round() as usize;
            paint(&mut m, w, x, y);
            paint(&mut m, w, x, y + 1);
        }
        let s = trace(&m, w, h, 5);
        assert_eq!(s.len(), 1);
        let sh = s[0].shape();
        let (arch, up) = sh.arch();
        assert!(up && (arch - 10.0).abs() < 1.5, "{sh:?}");
        assert!(sh.back() <= 1.0 && (sh.peak - 0.5).abs() < 0.1 && sh.thick == 2.0, "{sh:?}");
    }

    #[test]
    fn fork_splits_and_gap_joins() {
        let (w, h) = (100, 40);
        let mut m = vec![0u8; w * h];
        // 松叶：尖在左，两条边张开
        for x in 10..60 {
            let d = (x - 10) / 5;
            paint(&mut m, w, x, 20 - d);
            paint(&mut m, w, x, 20 + d);
        }
        let s = trace(&m, w, h, 8);
        assert_eq!(s.len(), 2, "{s:?}");
        assert!(s[0].shape().slope() < 0.0 && s[1].shape().slope() > 0.0);
        // 一条横线中间断了 6 列：接得上；不许过的接不上
        let mut m = vec![0u8; w * h];
        for x in (10..40).chain(46..80) {
            paint(&mut m, w, x, 10);
        }
        let parts = trace(&m, w, h, 8);
        assert_eq!(parts.len(), 2);
        let tol = JoinTol { max_gap: 10, dy: 2.0, dy_per_gap: 0.2, span: 8 };
        let joined = join_all(parts.clone(), tol, &|_, _| true);
        assert_eq!(joined.len(), 1);
        assert_eq!((joined[0].x0, joined[0].x1()), (10, 79));
        assert_eq!(join_all(parts, tol, &|_, _| false).len(), 2);
    }
}
