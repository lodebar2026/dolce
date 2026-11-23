//! **矢量对象库**（计划 §5.5「设计 3 / 3.1」）：页面内容（路径、文字层字符与字形轮廓）→ 识别用的对象，坐标换到工作坐标。
//!
//! - 对象归类：[`VKind::Line`]（只由直线段组成：描边两点线、细长的轴向填充矩形、多段折线）、[`VKind::Poly`]（无曲线的填充多边形：
//!   符杠的平行四边形、全 / 二分休止的矩形）、[`VKind::Curve`]（带曲线的细长对象：弧、延长记号的拱）、[`VKind::Glyph`]（文字层的字，
//!   或转曲后画字形的路径）。
//! - 直线段另列成 [`VLine`]（同一对象里描了好几遍的并成一条，线宽取重描跨度）：谱线、小节线、符干、加线从这里取。
//! - 逐点查询 [`VecPage::hits`]：网格索引 + 按几何作答（填充按非零环绕、描边按到折线的距离），回看墨迹的判据经它问。
//!
//! 矢量页的对象本来就分开画，压在一起互不影响，所以这里不做连通块、不做投影切分；
//! 要拆要并的只有确定性的结构情形（一个对象画几个字形、一个字形拆成几个对象、同一形状画两遍），见 [`merge_twins`]。
use crate::model::{PageContent, Seg, TextChar};
use dolce_omr_core::image::Rect;

/// 对象的种类。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VKind {
    Line,
    Poly,
    Curve,
    Glyph,
}

/// 对象从哪来。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ObjSrc {
    /// `PageContent::paths` 的下标。
    Path(usize),
    /// `PageContent::chars` 的下标。
    Char(usize),
}

/// 一个对象（工作坐标）。
#[derive(Clone, Debug)]
pub struct VObj {
    pub id: u32,
    pub kind: VKind,
    pub src: ObjSrc,
    pub rect: Rect,
    /// 压平的闭合环（填充）或折线（描边）。
    pub rings: Vec<Vec<(f64, f64)>>,
    pub fill: bool,
    /// 描边宽（工作单位）；不描为 0。
    pub stroke: f64,
    /// 原路径里有曲线段。
    pub curved: bool,
    /// 子路径数。
    pub subpaths: usize,
    /// 同一形状画了两遍（填充 + 描边）时并给的那一个；被并走的对象不再单独成候选。
    pub twin_of: Option<u32>,
}

/// 一条直线段（工作坐标）：两端与线宽。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VLine {
    pub obj: u32,
    pub a: (f64, f64),
    pub b: (f64, f64),
    pub w: f64,
}

impl VLine {
    pub fn len(&self) -> f64 {
        ((self.b.0 - self.a.0).powi(2) + (self.b.1 - self.a.1).powi(2)).sqrt()
    }
    pub fn is_empty(&self) -> bool {
        self.len() == 0.0
    }
    /// 横的（斜率不过 1:20）。
    pub fn is_h(&self) -> bool {
        (self.b.1 - self.a.1).abs() * 20.0 <= (self.b.0 - self.a.0).abs()
    }
    /// 竖的。
    pub fn is_v(&self) -> bool {
        (self.b.0 - self.a.0).abs() * 20.0 <= (self.b.1 - self.a.1).abs()
    }
}

/// 网格索引的格宽（工作单位）。
const CELL: f64 = 16.0;

/// 一页的矢量层。
#[derive(Clone, Debug)]
pub struct VecPage {
    /// 页面点 → 工作坐标：`(pt − origin) × scale`。
    pub scale: f64,
    pub origin: (f64, f64),
    /// 工作坐标的页宽高。
    pub w: usize,
    pub h: usize,
    pub objs: Vec<VObj>,
    pub lines: Vec<VLine>,
    /// 文字层的字（坐标仍是页面点，`VObj::src` 引它）。
    pub chars: Vec<TextChar>,
    grid_w: usize,
    grid: Vec<Vec<u32>>,
}

impl VecPage {
    /// 由页面内容建对象库。`scale` / `origin`：页面点换工作坐标（纯矢量页每点 [`dolce_omr_sheet`] 的 `VEC_SCALE` 单位、原点 0；
    /// 混合页按大图的像素格）。`clip`：只收中心落在这个页面框（点）里的对象（混合页给大图之外的部分时用 None）。
    pub fn build(pc: &PageContent, scale: f64, origin: (f64, f64)) -> VecPage {
        let tx = |x: f64, y: f64| ((x - origin.0) * scale, (y - origin.1) * scale);
        let (w, h) = (((pc.width - origin.0) * scale).ceil().max(1.0) as usize, ((pc.height - origin.1) * scale).ceil().max(1.0) as usize);
        let mut objs: Vec<VObj> = Vec::new();
        let mut lines: Vec<VLine> = Vec::new();
        for (pi, p) in pc.paths.iter().enumerate() {
            let fill = p.fill.is_some_and(|c| c[3] > 0 && !white(c));
            let stroke_on = p.stroke.is_some_and(|c| c[3] > 0 && !white(c));
            if !fill && !stroke_on {
                continue;
            }
            let lw = (p.line_width * scale).max(0.0);
            let (rings, curved, subs) = flatten(&p.segs, &tx);
            if rings.is_empty() {
                continue;
            }
            let id = objs.len() as u32;
            let rect = bounds(&rings);
            let mine = path_lines(&p.segs, &tx, id, if stroke_on { lw } else { 0.0 }, fill, stroke_on);
            let kind = if !curved && !mine.is_empty() && mine.len() >= straight_subpaths(&p.segs) {
                VKind::Line
            } else if !curved && fill {
                VKind::Poly
            } else if curved && subs <= 2 && (elongated(&rect) || fill && slim(&rings, &rect) && arc_like(&rings, &rect, &p.segs) || !fill && open_path(&p.segs)) {
                VKind::Curve
            } else if curved {
                VKind::Glyph
            } else {
                VKind::Line
            };
            if kind == VKind::Line {
                lines.extend(merge_redrawn(mine, 0.15 * scale));
            }
            objs.push(VObj { id, kind, src: ObjSrc::Path(pi), rect, rings, fill, stroke: if stroke_on { lw.max(0.5) } else { 0.0 }, curved, subpaths: subs, twin_of: None });
        }
        for (ci, c) in pc.chars.iter().enumerate() {
            if c.generated || c.unicode == 0x20 || c.bbox.w <= 0.0 && c.bbox.h <= 0.0 {
                continue;
            }
            let id = objs.len() as u32;
            let (rings, curved, subs) = match &c.outline {
                Some(o) => flatten(o, &tx),
                None => (Vec::new(), false, 0),
            };
            let (x0, y0) = tx(c.bbox.x, c.bbox.y);
            let rect = if rings.is_empty() { Rect::new(x0, y0, c.bbox.w * scale, c.bbox.h * scale) } else { bounds(&rings) };
            // 没轮廓的字按外框当填充块
            let rings = if rings.is_empty() { vec![vec![(rect.x, rect.y), (rect.right(), rect.y), (rect.right(), rect.bottom()), (rect.x, rect.bottom())]] } else { rings };
            // 轮廓全由细长的轴向矩形组成的字（Anastasia 的谱线 staff5Lines、符干、小节线、加线都是字形）：当线对象，化成直线段
            let mine = match &c.outline {
                Some(o) if !curved => path_lines(o, &tx, id, 0.0, true, false),
                _ => Vec::new(),
            };
            let kind = if !mine.is_empty() && c.outline.as_ref().is_some_and(|o| mine.len() >= straight_subpaths(o)) {
                lines.extend(merge_redrawn(mine, 0.15 * scale));
                VKind::Line
            } else {
                VKind::Glyph
            };
            objs.push(VObj { id, kind, src: ObjSrc::Char(ci), rect, rings, fill: true, stroke: 0.0, curved, subpaths: subs, twin_of: None });
        }
        merge_twins(&mut objs);
        let grid_w = (w as f64 / CELL).ceil() as usize + 1;
        let grid_h = (h as f64 / CELL).ceil() as usize + 1;
        let mut grid: Vec<Vec<u32>> = vec![Vec::new(); grid_w * grid_h];
        for o in &objs {
            let pad = o.stroke / 2.0 + 1.0;
            let (cx0, cy0) = (((o.rect.x - pad) / CELL).floor().max(0.0) as usize, ((o.rect.y - pad) / CELL).floor().max(0.0) as usize);
            let (cx1, cy1) = ((((o.rect.right() + pad) / CELL).floor().max(0.0) as usize).min(grid_w - 1), (((o.rect.bottom() + pad) / CELL).floor().max(0.0) as usize).min(grid_h - 1));
            for gy in cy0..=cy1.max(cy0).min(grid_h - 1) {
                for gx in cx0.min(grid_w - 1)..=cx1 {
                    grid[gy * grid_w + gx].push(o.id);
                }
            }
        }
        VecPage { scale, origin, w, h, objs, lines, chars: pc.chars.clone(), grid_w, grid }
    }

    /// 页面点的框 → 工作坐标。
    pub fn rect_of(&self, r: &Rect) -> Rect {
        Rect::new((r.x - self.origin.0) * self.scale, (r.y - self.origin.1) * self.scale, r.w * self.scale, r.h * self.scale)
    }

    /// 文字层字符（对象是字）。
    pub fn char_of(&self, o: &VObj) -> Option<&TextChar> {
        match o.src {
            ObjSrc::Char(i) => self.chars.get(i),
            _ => None,
        }
    }

    /// 点 (x, y) 落在哪些对象的墨里。
    pub fn hits(&self, x: f64, y: f64) -> impl Iterator<Item = &VObj> + '_ {
        let cell = if x < 0.0 || y < 0.0 { None } else { self.grid.get((y / CELL) as usize * self.grid_w + (x / CELL) as usize).filter(|_| ((x / CELL) as usize) < self.grid_w) };
        cell.into_iter().flat_map(|c| c.iter()).map(|&i| &self.objs[i as usize]).filter(move |o| contains(o, x, y))
    }

    /// 框里（与框相交）的对象。
    pub fn in_rect(&self, r: &Rect) -> Vec<&VObj> {
        let gh = self.grid.len() / self.grid_w;
        let (cx0, cy0) = ((r.x / CELL).floor().max(0.0) as usize, (r.y / CELL).floor().max(0.0) as usize);
        let (cx1, cy1) = (((r.right() / CELL).floor().max(0.0) as usize).min(self.grid_w - 1), ((r.bottom() / CELL).floor().max(0.0) as usize).min(gh - 1));
        let mut seen: Vec<u32> = Vec::new();
        for gy in cy0.min(gh - 1)..=cy1 {
            for gx in cx0.min(self.grid_w - 1)..=cx1 {
                for &i in &self.grid[gy * self.grid_w + gx] {
                    let o = &self.objs[i as usize];
                    if !seen.contains(&i) && o.rect.x <= r.right() && o.rect.right() >= r.x && o.rect.y <= r.bottom() && o.rect.bottom() >= r.y {
                        seen.push(i);
                    }
                }
            }
        }
        seen.sort_unstable();
        seen.into_iter().map(|i| &self.objs[i as usize]).collect()
    }
}

/// 白色（或近白）的填充 / 描边不是墨（遮白块）。
fn white(c: [u8; 4]) -> bool {
    c[0] >= 250 && c[1] >= 250 && c[2] >= 250
}

/// 扁长（细长曲线对象的外形）：长边过短边的 2.5 倍。
/// 只有一条不闭合的子路径（首尾不重合、没有 Close）：描边画的弧、一段段拼起来的弧的一段（字形是闭合的轮廓）。
fn open_path(segs: &[Seg]) -> bool {
    let mut first: Option<(f64, f64)> = None;
    let mut last = (0.0, 0.0);
    for s in segs {
        match *s {
            Seg::Move(x, y) => {
                if first.is_some() {
                    return false;
                }
                first = Some((x, y));
                last = (x, y);
            }
            Seg::Line(x, y) | Seg::Cubic(_, _, _, _, x, y) => last = (x, y),
            Seg::Close => return false,
        }
    }
    first.is_some_and(|f| (f.0 - last.0).abs() + (f.1 - last.1).abs() > 1e-3)
}

fn elongated(r: &Rect) -> bool {
    r.w.max(r.h) >= 2.5 * r.w.min(r.h).max(0.01)
}

/// 细的填充对象：面积占外框不到 [`SLIM_FILL`]（月牙形的弧；短而拱得高的延音线长宽比不到 2.5，但很细）。符头、实心块占得满。
const SLIM_FILL: f64 = 0.3;

fn slim(rings: &[Vec<(f64, f64)>], r: &Rect) -> bool {
    fill_area(rings) < SLIM_FILL * r.w * r.h
}

/// 不扁的细填充对象当弧还要结构简单（同 TS 转曲路）：短弧是两条曲线首尾相接的月牙，段数不过 [`ARC_SEGS`]；
/// 段多的（单笔轮廓画成的汉字「天」「下」，十几段）只有墨极细（不到外框的 [`ARC_INK`]，斜着走的长弧）才算。
const ARC_SEGS: usize = 6;
const ARC_INK: f64 = 0.15;

fn arc_like(rings: &[Vec<(f64, f64)>], r: &Rect, segs: &[Seg]) -> bool {
    let n = segs.iter().filter(|s| matches!(s, Seg::Line(..) | Seg::Cubic(..))).count();
    n <= ARC_SEGS || fill_area(rings) < ARC_INK * r.w * r.h
}

fn fill_area(rings: &[Vec<(f64, f64)>]) -> f64 {
    rings
        .iter()
        .map(|g| (0..g.len()).map(|i| {
            let (p, q) = (g[i], g[(i + 1) % g.len()]);
            p.0 * q.1 - q.0 * p.1
        }).sum::<f64>().abs() / 2.0)
        .sum()
}

fn bounds(rings: &[Vec<(f64, f64)>]) -> Rect {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for &(x, y) in rings.iter().flatten() {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    Rect::new(x0, y0, (x1 - x0).max(0.0), (y1 - y0).max(0.0))
}

/// 路径压平成折线（曲线按控制多边形长度细分），回（各子路径的点列、有无曲线、子路径数）。
pub fn flatten(segs: &[Seg], tx: &dyn Fn(f64, f64) -> (f64, f64)) -> (Vec<Vec<(f64, f64)>>, bool, usize) {
    let mut rings: Vec<Vec<(f64, f64)>> = Vec::new();
    let mut cur: Vec<(f64, f64)> = Vec::new();
    let (mut curved, mut subs) = (false, 0);
    for s in segs {
        match *s {
            Seg::Move(x, y) => {
                if cur.len() >= 2 {
                    rings.push(std::mem::take(&mut cur));
                }
                cur.clear();
                cur.push(tx(x, y));
                subs += 1;
            }
            Seg::Line(x, y) => cur.push(tx(x, y)),
            Seg::Cubic(x1, y1, x2, y2, x, y) => {
                curved = true;
                let p0 = *cur.last().unwrap_or(&tx(x1, y1));
                let (p1, p2, p3) = (tx(x1, y1), tx(x2, y2), tx(x, y));
                let d = |a: (f64, f64), b: (f64, f64)| ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt();
                let n = ((d(p0, p1) + d(p1, p2) + d(p2, p3)) / 2.0).ceil().clamp(4.0, 64.0) as usize;
                for k in 1..=n {
                    let t = k as f64 / n as f64;
                    let u = 1.0 - t;
                    let (a, b, c, e) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
                    cur.push((a * p0.0 + b * p1.0 + c * p2.0 + e * p3.0, a * p0.1 + b * p1.1 + c * p2.1 + e * p3.1));
                }
            }
            Seg::Close => {
                if let Some(&f) = cur.first() {
                    if cur.last() != Some(&f) {
                        cur.push(f);
                    }
                }
            }
        }
    }
    if cur.len() >= 2 {
        rings.push(cur);
    }
    (rings, curved, subs)
}

/// 没有曲线的子路径数。
fn straight_subpaths(segs: &[Seg]) -> usize {
    let mut n = 0;
    let mut cur_curved = false;
    let mut open = false;
    for s in segs {
        match s {
            Seg::Move(..) => {
                if open && !cur_curved {
                    n += 1;
                }
                open = true;
                cur_curved = false;
            }
            Seg::Cubic(..) => cur_curved = true,
            _ => {}
        }
    }
    if open && !cur_curved {
        n += 1;
    }
    n
}

/// 一个路径对象里的直线段：两点子路径、细长轴向矩形（取中线、线宽取短边）、多段折线逐段（只收横竖）。每个直子路径至少出一条才算「线对象」。
fn path_lines(segs: &[Seg], tx: &dyn Fn(f64, f64) -> (f64, f64), obj: u32, lw: f64, fill: bool, stroke: bool) -> Vec<VLine> {
    let mut out = Vec::new();
    let mut subs: Vec<(Vec<(f64, f64)>, bool)> = Vec::new();
    for s in segs {
        match *s {
            Seg::Move(x, y) => subs.push((vec![tx(x, y)], false)),
            Seg::Line(x, y) => {
                if let Some(c) = subs.last_mut() {
                    c.0.push(tx(x, y));
                }
            }
            Seg::Cubic(..) => {
                if let Some(c) = subs.last_mut() {
                    c.1 = true;
                }
            }
            Seg::Close => {}
        }
    }
    let lw = lw.max(0.5);
    for (mut pts, curved) in subs {
        if curved {
            continue;
        }
        pts.dedup_by(|a, b| (a.0 - b.0).abs() < 1e-6 && (a.1 - b.1).abs() < 1e-6);
        if pts.len() > 2 && pts.first() == pts.last() {
            pts.pop();
        }
        let vl = |a: (f64, f64), b: (f64, f64), w: f64| {
            let (a, b) = if a.0 + a.1 <= b.0 + b.1 { (a, b) } else { (b, a) };
            VLine { obj, a, b, w }
        };
        if pts.len() == 2 {
            if stroke || !fill {
                out.push(vl(pts[0], pts[1], lw));
            }
            continue;
        }
        if fill && pts.len() == 4 {
            if let Some((a, b, w)) = thin_rect(&pts) {
                out.push(vl(a, b, w));
                continue;
            }
            // 填充的粗四边形（符杠）不拆边
            if !stroke {
                continue;
            }
        }
        // 描边折线逐边成段（斜边也留：松叶的两条臂常是一条 M L L 折线；框架只取横、竖段）
        if pts.len() > 2 && stroke {
            for k in 1..pts.len() {
                out.push(vl(pts[k - 1], pts[k], lw));
            }
        }
    }
    out
}

/// 细长的轴向矩形：中线两端与短边（长边过短边 3 倍以上）。
/// 细长矩形：(一端, 另一端, 宽)
type ThinRect = ((f64, f64), (f64, f64), f64);

fn thin_rect(p: &[(f64, f64)]) -> Option<ThinRect> {
    let xs: Vec<f64> = p.iter().map(|q| q.0).collect();
    let ys: Vec<f64> = p.iter().map(|q| q.1).collect();
    let (x0, x1) = (xs.iter().cloned().fold(f64::MAX, f64::min), xs.iter().cloned().fold(f64::MIN, f64::max));
    let (y0, y1) = (ys.iter().cloned().fold(f64::MAX, f64::min), ys.iter().cloned().fold(f64::MIN, f64::max));
    // 轴向：每个点都在外框的角上
    let tol = 0.05 * (x1 - x0).max(y1 - y0).max(0.1);
    let corner = |q: &(f64, f64)| ((q.0 - x0).abs() < tol || (q.0 - x1).abs() < tol) && ((q.1 - y0).abs() < tol || (q.1 - y1).abs() < tol);
    if !p.iter().all(corner) {
        return None;
    }
    let (w, h) = (x1 - x0, y1 - y0);
    if w >= 3.0 * h {
        Some(((x0, (y0 + y1) / 2.0), (x1, (y0 + y1) / 2.0), h.max(0.5)))
    } else if h >= 3.0 * w {
        Some((((x0 + x1) / 2.0, y0), ((x0 + x1) / 2.0, y1), w.max(0.5)))
    } else {
        None
    }
}

/// 同一对象里描了好几遍的线并成一条：同向、中线相距不过 `tol`、长轴方向真的重叠（首尾相接的不并：加线与谱线）。
fn merge_redrawn(mut ls: Vec<VLine>, tol: f64) -> Vec<VLine> {
    if ls.len() < 2 {
        return ls;
    }
    let mut out: Vec<VLine> = Vec::new();
    for horiz in [true, false] {
        let mut v: Vec<VLine> = ls.iter().copied().filter(|l| if horiz { l.is_h() } else { l.is_v() && !l.is_h() }).collect();
        let key = |l: &VLine| if horiz { (l.a.1 + l.b.1) / 2.0 } else { (l.a.0 + l.b.0) / 2.0 };
        let lo = |l: &VLine| if horiz { l.a.0.min(l.b.0) } else { l.a.1.min(l.b.1) };
        let hi = |l: &VLine| if horiz { l.a.0.max(l.b.0) } else { l.a.1.max(l.b.1) };
        v.sort_by(|a, b| key(a).total_cmp(&key(b)));
        let mut used = vec![false; v.len()];
        for i in 0..v.len() {
            if used[i] {
                continue;
            }
            used[i] = true;
            let (mut k0, mut k1, mut p0, mut p1, mut w) = (key(&v[i]), key(&v[i]), lo(&v[i]), hi(&v[i]), v[i].w);
            for j in i + 1..v.len() {
                if key(&v[j]) - k1 >= tol {
                    break;
                }
                if !used[j] && lo(&v[j]) < p1 && hi(&v[j]) > p0 {
                    used[j] = true;
                    k1 = k1.max(key(&v[j]));
                    k0 = k0.min(key(&v[j]));
                    p0 = p0.min(lo(&v[j]));
                    p1 = p1.max(hi(&v[j]));
                    w = w.max(v[j].w);
                }
            }
            let c = (k0 + k1) / 2.0;
            let w = w.max(k1 - k0 + w.min(1.0));
            let obj = v[i].obj;
            out.push(if horiz { VLine { obj, a: (p0, c), b: (p1, c), w } } else { VLine { obj, a: (c, p0), b: (c, p1), w } });
        }
    }
    ls.retain(|l| !l.is_h() && !l.is_v());
    out.extend(ls);
    out
}

/// **同一形状画了两遍**（计划 §3.1）：外框重合（各边相差不过两者线宽之和）的填充对象与描边对象并成一组——
/// 弧 = 一条填充路径 + 一条描边路径（描边给弧加粗）、字填充外再描一圈。描边那个记 `twin_of` 指向填充那个，后面只认填充那个，
/// 厚度取并后的外沿（填充那个的外框扩到两者之并）。
pub fn merge_twins(objs: &mut [VObj]) {
    let n = objs.len();
    let mut order: Vec<usize> = (0..n).filter(|&i| matches!(objs[i].kind, VKind::Curve | VKind::Glyph | VKind::Poly) && matches!(objs[i].src, ObjSrc::Path(_))).collect();
    order.sort_by(|&a, &b| objs[a].rect.x.total_cmp(&objs[b].rect.x));
    for k in 0..order.len() {
        let i = order[k];
        if objs[i].twin_of.is_some() || !objs[i].fill {
            continue;
        }
        for &j in order.iter().skip(k + 1) {
            if objs[j].rect.x > objs[i].rect.x + 2.0 + objs[i].stroke + objs[j].stroke {
                break;
            }
            if j == i || objs[j].twin_of.is_some() || objs[j].fill || objs[j].stroke <= 0.0 {
                continue;
            }
            let tol = objs[i].stroke + objs[j].stroke + 0.5;
            let (a, b) = (objs[i].rect, objs[j].rect);
            if (a.x - b.x).abs() <= tol && (a.y - b.y).abs() <= tol && (a.right() - b.right()).abs() <= tol && (a.bottom() - b.bottom()).abs() <= tol {
                objs[j].twin_of = Some(objs[i].id);
                let pad = objs[j].stroke / 2.0;
                let (x0, y0) = (a.x.min(b.x - pad), a.y.min(b.y - pad));
                let (x1, y1) = (a.right().max(b.right() + pad), a.bottom().max(b.bottom() + pad));
                objs[i].rect = Rect::new(x0, y0, x1 - x0, y1 - y0);
                break;
            }
        }
    }
}

/// 点在对象的墨里：填充按非零环绕；描边按到折线的距离不过半个线宽（至少半个单位：细线也占一列）。
pub fn contains(o: &VObj, x: f64, y: f64) -> bool {
    let pad = o.stroke / 2.0 + 0.5;
    if x < o.rect.x - pad || x > o.rect.right() + pad || y < o.rect.y - pad || y > o.rect.bottom() + pad {
        return false;
    }
    if o.fill && winding(&o.rings, x, y) != 0 {
        return true;
    }
    if o.stroke > 0.0 || !o.fill {
        let half = (o.stroke / 2.0).max(0.5);
        for r in &o.rings {
            for w in r.windows(2) {
                if seg_dist2(w[0], w[1], (x, y)) <= half * half {
                    return true;
                }
            }
        }
    }
    false
}

fn winding(rings: &[Vec<(f64, f64)>], x: f64, y: f64) -> i32 {
    let mut wn = 0;
    for r in rings {
        let n = r.len();
        if n < 3 {
            continue;
        }
        for i in 0..n {
            let (a, b) = (r[i], r[(i + 1) % n]);
            if a.1 <= y {
                if b.1 > y && cross(a, b, (x, y)) > 0.0 {
                    wn += 1;
                }
            } else if b.1 <= y && cross(a, b, (x, y)) < 0.0 {
                wn -= 1;
            }
        }
    }
    wn
}

fn cross(a: (f64, f64), b: (f64, f64), p: (f64, f64)) -> f64 {
    (b.0 - a.0) * (p.1 - a.1) - (p.0 - a.0) * (b.1 - a.1)
}

fn seg_dist2(a: (f64, f64), b: (f64, f64), p: (f64, f64)) -> f64 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let l2 = dx * dx + dy * dy;
    let t = if l2 <= 0.0 { 0.0 } else { (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / l2).clamp(0.0, 1.0) };
    let (qx, qy) = (a.0 + t * dx, a.1 + t * dy);
    (p.0 - qx).powi(2) + (p.1 - qy).powi(2)
}

/// 文字层不可靠的字体：同一个字体里不同码点的字画着同一个轮廓（PDFium 把 CID 当码点交出、轮廓也取不对，如预置 CMap 的
/// `PMingLiU-ETen-B5-H`），或交出控制字符（没有码位映射的子集字体）。这些字只能从渲染的页面上裁条读。
pub fn unreliable_fonts(pc: &PageContent) -> Vec<String> {
    unreliable_fonts_of(&pc.chars)
}

/// 同 [`unreliable_fonts`]，吃字的列表。
pub fn unreliable_fonts_of(chars: &[TextChar]) -> Vec<String> {
    let mut seen: std::collections::HashMap<(String, Vec<i64>), u32> = std::collections::HashMap::new();
    let mut out: Vec<String> = Vec::new();
    for c in chars.iter().filter(|c| !c.generated) {
        // 交出控制字符的（没有码位映射，PDFium 把字形号当码点）
        if c.unicode < 0x20 {
            if !out.contains(&c.font) {
                out.push(c.font.clone());
            }
            continue;
        }
        if c.unicode == 0x20 {
            continue;
        }
        let Some(o) = &c.outline else { continue };
        // 轮廓相对第一点、按字号归一后量化的指纹
        let (mut fx, mut fy) = (f64::NAN, f64::NAN);
        let mut fp = Vec::new();
        for sg in o {
            let pts: &[(f64, f64)] = &match *sg {
                Seg::Move(x, y) | Seg::Line(x, y) => vec![(x, y)],
                Seg::Cubic(a, b, cc, d, x, y) => vec![(a, b), (cc, d), (x, y)],
                Seg::Close => vec![],
            };
            for &(x, y) in pts {
                if fx.is_nan() {
                    (fx, fy) = (x, y);
                }
                let k = c.size_scaled.max(0.01);
                fp.push(((x - fx) / k * 200.0).round() as i64);
                fp.push(((y - fy) / k * 200.0).round() as i64);
            }
        }
        if fp.len() < 6 {
            continue;
        }
        match seen.get(&(c.font.clone(), fp.clone())) {
            Some(&u) if u != c.unicode => {
                if !out.contains(&c.font) {
                    out.push(c.font.clone());
                }
            }
            Some(_) => {}
            None => {
                seen.insert((c.font.clone(), fp), c.unicode);
            }
        }
    }
    out
}

/// 路径画的字形块（转曲页）：一个路径对象里画了几个字形的（调号一串升号、一行字），按子路径外框相交并查成块，一块一个字形；
/// 块内的外轮廓与内腔外框必相交，挨着不碰的两个字形分开。
pub struct GlyphPiece {
    pub obj: u32,
    pub rings: Vec<Vec<(f64, f64)>>,
    pub rect: Rect,
    pub curved: bool,
}

/// 页上路径画的字形块（不含文字层的字）。
pub fn path_pieces(vp: &VecPage) -> Vec<GlyphPiece> {
    vp.objs.iter().filter(|o| o.kind == VKind::Glyph && matches!(o.src, ObjSrc::Path(_)) && o.twin_of.is_none()).flat_map(obj_pieces).collect()
}

/// 一个对象按子路径外框相交并查成块（见 [`GlyphPiece`]）。
pub fn obj_pieces(o: &VObj) -> Vec<GlyphPiece> {
    let mut out = Vec::new();
    let boxes: Vec<Rect> = o.rings.iter().map(|r| ring_rect(r)).collect();
    let n = boxes.len();
    let mut up: Vec<usize> = (0..n).collect();
    fn root(up: &mut [usize], mut i: usize) -> usize {
        while up[i] != i {
            up[i] = up[up[i]];
            i = up[i];
        }
        i
    }
    for i in 0..n {
        for j in i + 1..n {
            let (a, b) = (boxes[i], boxes[j]);
            if a.x <= b.right() && b.x <= a.right() && a.y <= b.bottom() && b.y <= a.bottom() {
                let (ri, rj) = (root(&mut up, i), root(&mut up, j));
                up[ri] = rj;
            }
        }
    }
    let mut groups: std::collections::BTreeMap<usize, Vec<usize>> = std::collections::BTreeMap::new();
    for i in 0..n {
        let r = root(&mut up, i);
        groups.entry(r).or_default().push(i);
    }
    for g in groups.into_values() {
        let rings: Vec<Vec<(f64, f64)>> = g.iter().map(|&i| o.rings[i].clone()).collect();
        let rect = g.iter().map(|&i| boxes[i]).reduce(|a, b| {
            let (x0, y0) = (a.x.min(b.x), a.y.min(b.y));
            Rect::new(x0, y0, a.right().max(b.right()) - x0, a.bottom().max(b.bottom()) - y0)
        });
        if let Some(rect) = rect {
            out.push(GlyphPiece { obj: o.id, rings, rect, curved: o.curved });
        }
    }
    out
}

fn ring_rect(r: &[(f64, f64)]) -> Rect {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for &(x, y) in r {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    Rect::new(x0, y0, (x1 - x0).max(0.0), (y1 - y0).max(0.0))
}


/// 一个对象画进格子：工作坐标 `(x, y)` → 格子 `((x − ox)·k, (y − oy)·k)`，落在墨里的格逐个交给 `set`。
/// 线对象按各直线段与线宽描；填充的按轮廓扫描线（非零环绕）；只描边的折线按线宽描。转曲字块、矢量简谱的裁条与混排的简谱条共用。
pub fn draw_obj(vp: &VecPage, o: &VObj, ox: f64, oy: f64, k: f64, w: usize, h: usize, set: &mut dyn FnMut(usize, usize)) {
    let mut put = |x: f64, y: f64| {
        let (px, py) = (((x - ox) * k).floor() as i64, ((y - oy) * k).floor() as i64);
        if px >= 0 && py >= 0 && (px as usize) < w && (py as usize) < h {
            set(px as usize, py as usize);
        }
    };
    let mut stroke = |a: (f64, f64), b: (f64, f64), half: f64| {
        let n = ((b.0 - a.0).hypot(b.1 - a.1) * 2.0 * k).ceil().max(1.0) as usize;
        let r = half.max(0.5 / k);
        let step = 0.5 / k;
        let m = (r / step).ceil() as i64;
        for i in 0..=n {
            let t = i as f64 / n as f64;
            let (cx, cy) = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
            for dy in -m..=m {
                for dx in -m..=m {
                    let (ex, ey) = (dx as f64 * step, dy as f64 * step);
                    if ex * ex + ey * ey <= r * r + step * step / 4.0 {
                        put(cx + ex, cy + ey);
                    }
                }
            }
        }
    };
    if o.kind == VKind::Line {
        for l in vp.lines.iter().filter(|l| l.obj == o.id) {
            stroke(l.a, l.b, l.w / 2.0);
        }
        return;
    }
    if o.fill {
        let rs: Vec<Vec<(f64, f64)>> = o.rings.iter().map(|r| r.iter().map(|&(x, y)| ((x - ox) * k, (y - oy) * k)).collect()).collect();
        dolce_omr_core::geom::fill_rings(&rs, w, h, set);
        return;
    }
    for r in &o.rings {
        for s in r.windows(2) {
            stroke(s[0], s[1], o.stroke / 2.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::PathObj;

    fn path(segs: Vec<Seg>, fill: bool, stroke: bool, lw: f64) -> PathObj {
        PathObj { segs, fill: fill.then_some([0, 0, 0, 255]), stroke: stroke.then_some([0, 0, 0, 255]), line_width: lw, even_odd: false, dashed: false, bbox: Rect::new(0.0, 0.0, 0.0, 0.0) }
    }

    #[test]
    fn classify_and_hits() {
        let pc = PageContent {
            width: 100.0,
            height: 100.0,
            images: vec![],
            paths: vec![
                // 横线（描边）
                path(vec![Seg::Move(10.0, 20.0), Seg::Line(90.0, 20.0)], false, true, 0.5),
                // 细长填充矩形（竖）
                path(vec![Seg::Move(50.0, 10.0), Seg::Line(50.5, 10.0), Seg::Line(50.5, 40.0), Seg::Line(50.0, 40.0), Seg::Close], true, false, 0.0),
                // 平行四边形（符杠）
                path(vec![Seg::Move(10.0, 50.0), Seg::Line(30.0, 48.0), Seg::Line(30.0, 50.0), Seg::Line(10.0, 52.0), Seg::Close], true, false, 0.0),
            ],
            chars: vec![],
        };
        let vp = VecPage::build(&pc, 4.0, (0.0, 0.0));
        assert_eq!(vp.objs.iter().map(|o| o.kind).collect::<Vec<_>>(), vec![VKind::Line, VKind::Line, VKind::Poly]);
        assert_eq!(vp.lines.len(), 2);
        assert!(vp.lines[0].is_h() && vp.lines[1].is_v());
        assert_eq!(vp.hits(160.0, 80.0).count(), 1); // 横线上
        assert_eq!(vp.hits(160.0, 83.0).count(), 0);
        assert_eq!(vp.hits(80.0, 200.0).count(), 1); // 符杠里
        assert_eq!(vp.hits(201.0, 100.0).count(), 1); // 竖矩形里
    }

    #[test]
    fn redrawn_lines_merge() {
        let l = |y: f64| VLine { obj: 0, a: (0.0, y), b: (100.0, y), w: 0.24 };
        let m = merge_redrawn(vec![l(10.0), l(10.24), l(10.48), VLine { obj: 0, a: (100.0, 10.0), b: (120.0, 10.0), w: 0.24 }], 0.6);
        assert_eq!(m.len(), 2, "{m:?}");
        assert!((m[0].a.1 - 10.24).abs() < 1e-9 && m[0].w > 0.4);
    }
}
