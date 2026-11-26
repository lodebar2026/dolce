//! 矢量页的**细笔画原语**（计划 §5.5「设计 3.1 / 5」）：曲线对象与不竖、不厚、不是谱线的直线段逐列取样成
//! 「一列一段墨」的 [`Stroke`]，交与位图同一份的弧、松叶、房子判据（`spans::judge`）。
//!
//! 矢量对象本来分开画：弧压着歌词、贴着符头都不粘，不用细墨掩膜、不用跨谱线拼接。
//! 同一条弧画两遍（填充的月牙 + 描边加粗）的，对象库已并成一组（`twin_of`），这里按组取外沿：只出一条笔画。
use crate::spans::Piece;
use dolce_omr_core::sheet::curves::Stroke;
use dolce_omr_core::source::vector::{VKind, VLine, VObj, VecPage};

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

/// 两个曲线对象端点相接：端点相距不过这么多（相对线距）。
const CHAIN_GAP: f64 = 0.12;
/// 一条弧的两条边：外框横向交叠占窄的那个的这么多，纵向也交叠。
const EDGE_OVERLAP: f64 = 0.6;

/// 折线的两个端点。
fn ends(o: &VObj) -> Option<[(f64, f64); 2]> {
    let r = o.rings.first()?;
    Some([*r.first()?, *r.last()?])
}

/// 曲线对象分组（并查）：画两遍的（`twin_of`）、外框大半交叠的（一条弧的上下两条边）、端点相接的（一段接一段）归一组。
fn curve_groups(vp: &VecPage, sp: f64) -> Vec<Vec<&VObj>> {
    let cs: Vec<&VObj> = vp.objs.iter().filter(|o| o.kind == VKind::Curve).collect();
    let mut up: Vec<usize> = (0..cs.len()).collect();
    fn root(up: &mut [usize], mut i: usize) -> usize {
        while up[i] != i {
            up[i] = up[up[i]];
            i = up[i];
        }
        i
    }
    let tol = CHAIN_GAP * sp;
    let mut order: Vec<usize> = (0..cs.len()).collect();
    order.sort_by(|&a, &b| cs[a].rect.x.total_cmp(&cs[b].rect.x));
    for (k, &i) in order.iter().enumerate() {
        for &j in &order[k + 1..] {
            let (a, b) = (cs[i], cs[j]);
            if b.rect.x > a.rect.right() + tol {
                break;
            }
            let twin = a.twin_of == Some(b.id) || b.twin_of == Some(a.id);
            let xo = a.rect.right().min(b.rect.right()) - a.rect.x.max(b.rect.x);
            let yo = a.rect.bottom().min(b.rect.bottom()) - a.rect.y.max(b.rect.y);
            let edges = !a.fill && !b.fill && xo >= EDGE_OVERLAP * a.rect.w.min(b.rect.w) && yo > 0.0;
            let chain = match (ends(a), ends(b)) {
                (Some(ea), Some(eb)) if !a.fill && !b.fill => ea.iter().any(|p| eb.iter().any(|q| (p.0 - q.0).hypot(p.1 - q.1) <= tol)),
                _ => false,
            };
            if twin || edges || chain {
                let (ri, rj) = (root(&mut up, i), root(&mut up, j));
                up[ri] = rj;
            }
        }
    }
    let mut groups: std::collections::BTreeMap<usize, Vec<&VObj>> = std::collections::BTreeMap::new();
    for (i, &c) in cs.iter().enumerate() {
        let r = root(&mut up, i);
        groups.entry(r).or_default().push(c);
    }
    groups.into_values().collect()
}

/// 一页的细笔画。`staff_lines`：谱线段（`vp.lines` 的下标）；`sp`：线距。
pub fn pieces(vp: &VecPage, staff_lines: &[usize], sp: f64) -> Vec<Piece> {
    let mut out: Vec<Stroke> = Vec::new();
    // 曲线对象：画两遍的（填充 + 描边）、一条弧的上下两条边、一段接一段拼起来的，并成一组按组取外沿
    for g in curve_groups(vp, sp) {
        let (x0, x1) = (g.iter().map(|o| o.rect.x).fold(f64::MAX, f64::min), g.iter().map(|o| o.rect.right()).fold(f64::MIN, f64::max));
        if x1 - x0 < MIN_PIECE * sp {
            continue;
        }
        let ext = |x: f64| g.iter().filter_map(|t| obj_extent(t, x)).reduce(|p, q| (p.0.min(q.0), p.1.max(q.1)));
        out.extend(sample(x0, x1, &ext));
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
