//! 松叶（渐强 / 渐弱）：两条直的细笔画，一头挨着、另一头张开。整条连着尖的松叶在追踪时已在尖处分成两条边。
use super::Piece;
use crate::page::Layout;

/// 一条边：宽度下限（相对线距）、离两端连线最远不过这么多（弧拱得高）、斜率上限、墨厚上限。
const ARM_MIN_W: f64 = 2.0;
const ARM_DEV: f64 = 0.2;
const ARM_SLOPE: f64 = 0.35;
const ARM_THICK: f64 = 0.3;
/// 两条边横向交叠不少于较长那条的这么多；尖的一头两边相隔不过、开口一头不少于 / 不多于这么多（相对线距），开口至少是尖的这么多倍。
const OVERLAP: f64 = 0.6;
const TIP_MAX: f64 = 0.5;
const OPEN_MIN: f64 = 0.55;
const OPEN_MAX: f64 = 3.2;
const OPEN_RATIO: f64 = 2.0;
/// 松叶在上面那行谱底线之下这么远（相对线距）以内，归上面那行。
const ABOVE_FAR: f64 = 14.0;
const BELOW_NEAR: f64 = 0.5;

/// 一条松叶：归哪一行谱（它上面那行）、横向范围、中线 y、尖在左（渐强）。
#[derive(Clone, Debug, PartialEq)]
pub struct Wedge {
    pub staff: usize,
    pub x0: f64,
    pub x1: f64,
    pub y: f64,
    pub cresc: bool,
}

pub fn wedges(f: &Layout, pieces: &[Piece]) -> Vec<Wedge> {
    let sp = f.unit.space;
    // 谱表里的直笔画（没标成存疑的谱线残段、加粗的线）不当边
    let in_staff = |p: &Piece| {
        let (x, y) = ((p.shape.a.0 + p.shape.b.0) / 2.0, p.mid_y());
        f.staves.iter().any(|s| x >= s.left && x <= s.right && s.covers(x, y, 0.3))
    };
    let arms: Vec<&Piece> = pieces
        .iter()
        .filter(|p| p.width() >= ARM_MIN_W * sp && p.shape.up.max(p.shape.down) <= ARM_DEV * sp && p.shape.slope().abs() <= ARM_SLOPE && p.shape.thick <= ARM_THICK * sp && !in_staff(p))
        .collect();
    let mut out: Vec<Wedge> = Vec::new();
    let mut used = vec![false; arms.len()];
    for i in 0..arms.len() {
        for j in 0..arms.len() {
            if i == j || used[i] || used[j] {
                continue;
            }
            // u 在上、l 在下
            let (u, l) = (&arms[i].stroke, &arms[j].stroke);
            let (xa, xb) = (u.x0.max(l.x0), u.x1().min(l.x1()));
            if (xb - xa) as f64 <= OVERLAP * u.width().max(l.width()) {
                continue;
            }
            let (ga, gb) = (l.mid(xa) - u.mid(xa), l.mid(xb) - u.mid(xb));
            // 尖那头两边可以贴住（精确几何的尖端间距正好是 0），不能交叉
            if ga < 0.0 || gb < 0.0 || ga.max(gb) <= 0.0 {
                continue;
            }
            let (tip, open) = (ga.min(gb), ga.max(gb));
            if tip > TIP_MAX * sp || open < OPEN_MIN * sp || open > OPEN_MAX * sp || open < OPEN_RATIO * tip {
                continue;
            }
            let (x0, x1) = (u.x0.min(l.x0) as f64, u.x1().max(l.x1()) as f64);
            let y = (u.mid(xa) + l.mid(xa) + u.mid(xb) + l.mid(xb)) / 4.0;
            let mx = (x0 + x1) / 2.0;
            // 归它上面那行谱（松叶印在所属谱表的下方、歌词之上）；上面没有谱表的归下面最近的
            let over = |k: &usize| mx >= f.staves[*k].left && mx <= f.staves[*k].right;
            let above = (0..f.staves.len()).filter(over).filter(|&k| f.staves[k].bottom(mx) < y && y - f.staves[k].bottom(mx) <= ABOVE_FAR * f.staves[k].space()).max_by(|&p, &q| f.staves[p].bottom(mx).total_cmp(&f.staves[q].bottom(mx)));
            let below = (0..f.staves.len()).filter(over).filter(|&k| f.staves[k].top(mx) > y).min_by(|&p, &q| f.staves[p].top(mx).total_cmp(&f.staves[q].top(mx)));
            // 贴着下面那行谱（离它不到离上面那行的 [`BELOW_NEAR`]）的归下面
            let staff = match (above, below) {
                (Some(a), Some(b)) if (f.staves[b].top(mx) - y) < BELOW_NEAR * (y - f.staves[a].bottom(mx)) => b,
                (Some(a), _) => a,
                (None, Some(b)) => b,
                _ => continue,
            };
            used[i] = true;
            used[j] = true;
            out.push(Wedge { staff, x0, x1, y, cresc: ga < gb });
        }
    }
    out.sort_by(|a, b| a.staff.cmp(&b.staff).then(a.x0.total_cmp(&b.x0)));
    out
}
