//! 矢量页的**细笔画原语**（计划 §5.5「设计 3.1 / 5」）：曲线对象与不竖、不厚、不是谱线的直线段逐列取样成
//! 「一列一段墨」的 [`Stroke`]，交与位图同一份的弧、松叶、房子判据（`spans::judge`）。
//!
//! 矢量对象本来分开画：弧压着歌词、贴着符头都不粘，不用细墨掩膜、不用跨谱线拼接。
//! 同一条弧画两遍（填充的月牙 + 描边加粗）的，对象库已并成一组（`twin_of`），这里按组取外沿：只出一条笔画。
use crate::spans::Piece;
use dolce_omr_sheet::curves::Stroke;
use dolce_omr_source::vector::{VKind, VLine, VObj, VecPage};

/// 细：直线段线宽不过这么多（相对线距；同位图的细墨上限）。更厚的是符杠、粗小节线。
const THIN: f64 = 0.45;
/// 笔画至少这么宽（相对线距；同位图的碎段下限）。
const MIN_PIECE: f64 = 0.25;

/// 对象在竖线 `x` 上的墨的上下沿：填充取各环与竖线交点的最上最下；描边取交点上下各加半个线宽。
fn obj_extent(o: &VObj, x: f64) -> Option<(f64, f64)> {
    let mut ys: Vec<f64> = Vec::new();
    for r in &o.rings {
        let n = r.len();
        let segs = if o.fill { n } else { n.saturating_sub(1) };
        for i in 0..segs {
            let (p, q) = (r[i], r[(i + 1) % n]);
            let (lo, hi) = if p.0 <= q.0 { (p, q) } else { (q, p) };
            if x < lo.0 || x > hi.0 || hi.0 - lo.0 <= 1e-9 {
                continue;
            }
            ys.push(lo.1 + (hi.1 - lo.1) * (x - lo.0) / (hi.0 - lo.0));
        }
    }
    let (a, b) = (ys.iter().copied().fold(f64::MAX, f64::min), ys.iter().copied().fold(f64::MIN, f64::max));
    if ys.is_empty() {
        return None;
    }
    let half = if o.fill { 0.0 } else { (o.stroke / 2.0).max(0.5) };
    Some((a - half, b + half))
}

/// 直线段在竖线 `x` 上的墨。
fn line_extent(l: &VLine, x: f64) -> Option<(f64, f64)> {
    let (lo, hi) = if l.a.0 <= l.b.0 { (l.a, l.b) } else { (l.b, l.a) };
    if x < lo.0 || x > hi.0 || hi.0 - lo.0 <= 1e-9 {
        return None;
    }
    let y = lo.1 + (hi.1 - lo.1) * (x - lo.0) / (hi.0 - lo.0);
    let half = (l.w / 2.0).max(0.5);
    Some((y - half, y + half))
}

/// 在 `[x0, x1]` 上逐列（列心）取样成笔画；取不到的列沿用上一列。
fn sample(x0: f64, x1: f64, ext: &dyn Fn(f64) -> Option<(f64, f64)>) -> Option<Stroke> {
    let (a, b) = (x0.floor() as i64, x1.ceil() as i64 - 1);
    if b < a {
        return None;
    }
    let mut cols: Vec<(i32, i32)> = Vec::with_capacity((b - a + 1) as usize);
    let mut last: Option<(i32, i32)> = None;
    for x in a..=b {
        let c = ext(x as f64 + 0.5).map(|(t, u)| {
            let t = t.floor() as i32;
            (t, (u.ceil() as i32 - 1).max(t))
        });
        match c.or(last) {
            Some(c) => {
                cols.push(c);
                last = Some(c);
            }
            None if cols.is_empty() => continue,
            None => return None,
        }
    }
    let lead = (b - a + 1) as usize - cols.len();
    (!cols.is_empty()).then(|| Stroke { x0: a + lead as i64, cols })
}

/// 一页的细笔画。`staff_lines`：谱线段（`vp.lines` 的下标）；`sp`：线距。
pub fn pieces(vp: &VecPage, staff_lines: &[usize], sp: f64) -> Vec<Piece> {
    let mut out: Vec<Stroke> = Vec::new();
    // 曲线对象：画两遍的按组取外沿
    for o in vp.objs.iter().filter(|o| o.kind == VKind::Curve && o.twin_of.is_none()) {
        if o.rect.w < MIN_PIECE * sp {
            continue;
        }
        let twins: Vec<&VObj> = vp.objs.iter().filter(|t| t.twin_of == Some(o.id)).collect();
        let ext = |x: f64| {
            std::iter::once(o).chain(twins.iter().copied()).filter_map(|t| obj_extent(t, x)).reduce(|p, q| (p.0.min(q.0), p.1.max(q.1)))
        };
        out.extend(sample(o.rect.x, o.rect.right(), &ext));
    }
    // 直线段：谱线、竖的、厚的、短的不要
    for (i, l) in vp.lines.iter().enumerate() {
        if staff_lines.contains(&i) || l.is_v() || l.w > THIN * sp || (l.b.0 - l.a.0).abs() < MIN_PIECE * sp {
            continue;
        }
        out.extend(sample(l.a.0.min(l.b.0), l.a.0.max(l.b.0), &|x| line_extent(l, x)));
    }
    out.into_iter().map(|stroke| Piece { shape: stroke.shape(), stroke }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_sampled_per_column() {
        let l = VLine { obj: 0, a: (10.0, 20.0), b: (30.0, 30.0), w: 2.0 };
        let s = sample(10.0, 30.0, &|x| line_extent(&l, x)).unwrap();
        assert_eq!((s.x0, s.x1()), (10, 29));
        // 列心 10.5 处中线 20.25，上下各一：19.25 ~ 21.25
        assert_eq!(s.cols[0], (19, 21));
        assert!(s.cols.iter().all(|c| c.1 >= c.0));
    }
}
