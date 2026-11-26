//! 弧线（圆滑线 / 延音线，及三连音的两段弧，`engrave/arc.ts`）：样式参数、弧高与控制点两个纯函数、简谱弧的定位小件，
//! 以及月牙形图元本身（`Slur` / `Tie`：填充 + 描边、扁平长连音线、断口）。

use dolce_model::base::geom::Point;
use crate::scene::{Node, Role};

use crate::Env;

/// 弧线的样式参数。
#[derive(Clone, Debug, PartialEq, Default)]
pub struct SlurStyle {
    /// 月牙形的最大厚度
    pub thickness: f64,
    pub color: f64,
    pub height_scale: Option<f64>,
    pub outline_width: Option<f64>,
    /// 弧高上限（未乘 heightScale）；<=0 或不给 = 不封顶
    pub max_height: Option<f64>,
    /// 弧高下限；<=0 或不给 = 只用公式自带的 1.2
    pub min_height: Option<f64>,
    /// 跨度超过它改画扁平长连音线
    pub flat_span: Option<f64>,
    pub force_flat: bool,
    pub flat_ratio: Option<f64>,
    pub flat_line_width: Option<f64>,
    /// 开口朝向：缺省朝上（弧在音符上方）；`down` 只给混排五线谱层
    pub side_down: bool,
    /// 中间挖掉 `[x0, x1]` 这一截
    pub gap: Option<(f64, f64)>,
}

fn pos(o: Option<f64>) -> Option<f64> {
    o.filter(|v| *v > 0.0)
}

/// 弧高（正数）。**这是弧高的唯一算法**。
pub fn arc_height(dist: f64, o: &SlurStyle) -> f64 {
    let floor = pos(o.min_height).unwrap_or(1.2);
    let raw = dolce_model::base::js::max(dolce_model::base::js::max(dist, 1e-6).log10() * 17.0 - 16.0, floor);
    let cap = match pos(o.max_height) {
        Some(m) => dolce_model::base::js::max(m, floor),
        None => f64::INFINITY,
    };
    dolce_model::base::js::min(raw, cap) * o.height_scale.unwrap_or(1.0)
}

/// 控制点：返回 (p1, p2, cos)。
pub fn calc_slur_points(pl: Point, pr: Point, o: &SlurStyle) -> (Point, Point, f64) {
    let (xr, xl, yr, yl) = (pr.x, pl.x, pr.y, pl.y);
    let dx = xr - xl;
    let dy = yr - yl;
    let square = dx * dx + dy * dy;
    let dist = square.sqrt();
    let theta = dy.atan2(dx);
    let cos = (-theta).cos();
    let sin = (-theta).sin();
    let xlen = dolce_model::base::js::min(dist * 0.04 + 10.0, dist * 0.25);
    let h = arc_height(dist, o) * if o.side_down { 1.0 } else { -1.0 };
    let p1 = Point::new(xlen, h).rotate(cos, sin).offset(xl, yl);
    let p2 = Point::new(dist - xlen, h).rotate(cos, sin).offset(xl, yl);
    (p1, p2, cos)
}

/// 首尾相接的两条弧在接点各内缩数字字号的这么几分之一。
pub const ARC_CHAIN_INSET_DIV: f64 = 14.0;

/// 简谱弧的端点高度：起止两摞墨迹顶取高者，再往上一道 `gap`。
pub fn jp_arc_y(start_top: f64, end_top: f64, gap: f64) -> f64 {
    dolce_model::base::js::min(start_top, end_top) - gap
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ArcObstacle {
    pub x: f64,
    pub y: f64,
}

/// 弧要整条挪多少才让开这些障碍、再留一道 `gap`（抛物线近似）。朝上为负、朝下为正；不用挪 0。
#[allow(clippy::too_many_arguments)]
pub fn arc_clear_shift(x0: f64, y0: f64, x1: f64, y1: f64, rise: f64, above: bool, obstacles: &[ArcObstacle], gap: f64) -> f64 {
    if x1 - x0 <= 1e-6 {
        return 0.0;
    }
    let mut shift = 0.0;
    for o in obstacles {
        if o.x <= x0 || o.x >= x1 {
            continue;
        }
        let u = (o.x - x0) / (x1 - x0);
        let line = y0 + (y1 - y0) * u;
        let bulge = rise * 4.0 * u * (1.0 - u);
        if above {
            shift = dolce_model::base::js::min(shift, o.y - gap - (line - bulge));
        } else {
            shift = dolce_model::base::js::max(shift, o.y + gap - (line + bulge));
        }
    }
    shift
}

/// 弧顶离端点连线多高：控制点高的 0.75。
pub fn arc_rise(dist: f64, o: &SlurStyle) -> f64 {
    arc_height(dist, o) * 0.75
}

// ───────────────────────── 弧线图元 ─────────────────────────

type Bez = [Point; 4];

fn lerp(u: Point, v: Point, t: f64) -> Point {
    Point::new(u.x + (v.x - u.x) * t, u.y + (v.y - u.y) * t)
}

fn split(q: &Bez, t: f64) -> (Bez, Bez) {
    let p01 = lerp(q[0], q[1], t);
    let p12 = lerp(q[1], q[2], t);
    let p23 = lerp(q[2], q[3], t);
    let p012 = lerp(p01, p12, t);
    let p123 = lerp(p12, p23, t);
    let m = lerp(p012, p123, t);
    ([q[0], p01, p012, m], [m, p123, p23, q[3]])
}

/// 三次贝塞尔在 `[a, b]` 这一段。
fn bezier_seg(p: &Bez, a: f64, b: f64) -> Bez {
    let head = if b >= 1.0 { *p } else { split(p, b).0 };
    if a <= 0.0 {
        head
    } else {
        split(&head, a / b).1
    }
}

/// 三次贝塞尔上 x 取 `x` 的参数 t（二分 40 次）。
fn bezier_t_at_x(p: &Bez, x: f64) -> f64 {
    let x_at = |t: f64| {
        let u = 1.0 - t;
        u * u * u * p[0].x + 3.0 * u * u * t * p[1].x + 3.0 * u * t * t * p[2].x + t * t * t * p[3].x
    };
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..40 {
        let mid = (lo + hi) / 2.0;
        if x_at(mid) < x {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo + hi) / 2.0
}

/// 弧的种类（TS 两个类）。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ArcKind {
    Slur,
    /// 延音线：连的两个和弦（`ScoreDoc` 元素 id）；多连音弧不填
    Tie { start_id: Option<u32>, end_id: Option<u32> },
}

/// 建一条弧（`new Slur()` / `new Tie()` 再 `init`）：组节点，角色记扁平钩长 `flatHx`。
pub fn slur_tie(kind: ArcKind, pl: Point, pr: Point, style: &SlurStyle, env: &Env) -> Node {
    let mut g = Node::group();
    let flat_hx = init(&mut g, pl, pr, style, env);
    g.role = Some(match kind {
        ArcKind::Slur => Role::Slur { flat_hx },
        ArcKind::Tie { start_id, end_id } => Role::Tie { flat_hx, start_id, end_id },
    });
    g
}

/// `SlurTieBase.init`：画进组，返回扁平钩长（画成弧的是 0）。
fn init(g: &mut Node, pl: Point, pr: Point, style: &SlurStyle, env: &Env) -> f64 {
    let dx = pr.x - pl.x;
    let dy = pr.y - pl.y;
    let dist = (dx * dx + dy * dy).sqrt();
    let arc_h = arc_height(dist, style) * 0.75;
    let flat_by_ratio = pos(style.flat_ratio).is_some_and(|r| arc_h > 0.0 && dist / arc_h > r);
    if style.gap.is_some() {
        init_arc(g, pl, pr, style, env);
        return 0.0;
    }
    if style.force_flat || flat_by_ratio || pos(style.flat_span).is_some_and(|s| dist > s) {
        return init_flat(g, pl, pr, dist, style, env);
    }
    init_arc(g, pl, pr, style, env);
    0.0
}

fn init_arc(g: &mut Node, pl: Point, pr: Point, style: &SlurStyle, env: &Env) {
    let (pt0, pt1, cos) = calc_slur_points(pl, pr, style);
    let clr = style.color;
    let lw0 = style.thickness / cos;
    let upper: Bez = [pl, pt0, pt1, pr];
    let lower: Bez = [pl, pt0.offset(0.0, lw0 / 2.0), pt1.offset(0.0, lw0 / 2.0), pr];
    let mid: Bez = [pl, pt0.offset(0.0, lw0 / 4.0), pt1.offset(0.0, lw0 / 4.0), pr];
    let spans: Vec<(f64, f64)> = match style.gap {
        Some((gx0, gx1)) => {
            let tl = bezier_t_at_x(&upper, gx0);
            let tr = bezier_t_at_x(&upper, gx1);
            vec![(0.0, tl), (tr, 1.0)]
        }
        None => vec![(0.0, 1.0)],
    };
    let mut paths = Vec::new();
    for &(a, b) in &spans {
        let up = bezier_seg(&upper, a, b);
        let lo = bezier_seg(&lower, a, b);
        let mut obj = Node::path();
        let p = obj.path_mut();
        p.fill = true;
        p.stroke = false;
        p.fill_color = clr;
        p.move_to_p(up[0]);
        p.cubic_to_p(up[1], up[2], up[3]);
        if lo[3].x != up[3].x || lo[3].y != up[3].y {
            p.line_to_p(lo[3]);
        }
        p.cubic_to_p(lo[2], lo[1], lo[0]);
        p.close();
        paths.push(obj);
    }
    for &(a, b) in &spans {
        let md = bezier_seg(&mid, a, b);
        let mut outline = Node::path();
        let p = outline.path_mut();
        p.fill = false;
        p.stroke = true;
        p.stroke_width = style.outline_width.unwrap_or(0.7);
        p.stroke_color = clr;
        p.move_to_p(md[0]);
        p.cubic_to_p(md[1], md[2], md[3]);
        paths.push(outline);
    }
    finish(g, paths, env);
}

fn init_flat(g: &mut Node, pl: Point, pr: Point, dist: f64, style: &SlurStyle, env: &Env) -> f64 {
    let h = arc_height(pos(style.flat_span).unwrap_or(dist), style) * 0.75;
    let hx = dolce_model::base::js::min(dist * 0.12, h * 2.5);
    let t = pos(style.flat_line_width).unwrap_or(style.thickness * 0.45);
    let mut obj = Node::path();
    let p = obj.path_mut();
    p.fill = true;
    p.stroke = false;
    p.fill_color = style.color;
    flat_edge(p, pl, pr, hx, h, 0.0, false);
    flat_edge(p, pl, pr, hx, h, t, true);
    p.close();
    finish(g, vec![obj], env);
    hx
}

/// 扁平连音线的一条边：`down` = 回程（从右往左、整体下压 `dy`）。
fn flat_edge(p: &mut crate::scene::PathShape, pl: Point, pr: Point, hx: f64, h: f64, dy: f64, down: bool) {
    let top_l = pl.y - h + dy;
    let top_r = pr.y - h + dy;
    if !down {
        p.move_to_p(pl);
        p.cubic_to_p(Point::new(pl.x + hx * 0.15, pl.y - h * 0.55), Point::new(pl.x + hx * 0.45, top_l), Point::new(pl.x + hx, top_l));
        p.line_to_p(Point::new(pr.x - hx, top_r));
        p.cubic_to_p(Point::new(pr.x - hx * 0.45, top_r), Point::new(pr.x - hx * 0.15, pr.y - h * 0.55), pr);
    } else {
        p.cubic_to_p(Point::new(pr.x - hx * 0.15, pr.y - h * 0.55 + dy), Point::new(pr.x - hx * 0.45, top_r), Point::new(pr.x - hx, top_r));
        p.line_to_p(Point::new(pl.x + hx, top_l));
        p.cubic_to_p(Point::new(pl.x + hx * 0.45, top_l), Point::new(pl.x + hx * 0.15, pl.y - h * 0.55 + dy), pl);
    }
}

/// 把画好的路径挪到自身坐标系原点，包围盒记到组的 x / y / 宽高上。
fn finish(g: &mut Node, mut paths: Vec<Node>, env: &Env) {
    let mut bx = paths[0].path_ref().unwrap().tight_bounds(env.mc);
    for p in &paths[1..] {
        bx = bx.union(&p.path_ref().unwrap().tight_bounds(env.mc));
    }
    for p in &mut paths {
        p.path_mut().offset(-bx.left, -bx.top);
        p.set_x(0.0);
        p.set_y(0.0);
        p.w = bx.width();
        p.h = bx.height();
    }
    g.k.extend(paths);
    g.set_x(bx.left);
    g.set_y(bx.top);
    g.w = bx.width();
    g.h = bx.height();
}

/// 弧角色上的扁平钩长（画成弧的是 0）。
pub fn flat_hx(n: &Node) -> f64 {
    match n.role {
        Some(Role::Slur { flat_hx }) | Some(Role::Tie { flat_hx, .. }) => flat_hx,
        _ => 0.0,
    }
}
