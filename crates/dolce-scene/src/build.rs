//! 构建期：节点的造法与 `update` / `bound` / `childrenBound` 语义，照 `src/pagetree/pageitem.ts` 各类逐条搬
//! （骨架一字不差的前提——谁在什么时候归一坐标、盒按哪种口径取，都和 TS 一样）。
//!
//! TS 的派生类在这里是「形 + 角色」：
//!
//! | TS | 形 | 角色 |
//! |---|---|---|
//! | `PageItem` | `Item` | — |
//! | `Group`、`SlurTieBase`（`Slur` / `Tie`） | `Group` | 弧有 `Slur` / `Tie` |
//! | `GraphicPath`、`JpOctaveDot` | `Path` | 点有 `JpOctaveDot` |
//! | `GraphicLine`、`BeamLine` | `Line` | 减时线有 `BeamLine` |
//! | `TextFrame`、`JpNumber`、`Lyric` | `Text` | 数字 `JpNumber`、歌词 `Lyric` |
//! | `SmuflText` | `Smufl` | — |
//!
//! 盒只有 SMuFL 字会取不到（码位不在元数据里，TS 抛错）：[`bound`] 给 `None`，[`update`] 碰上就报 [`SceneError`]。

use dolce_geom::{colors, Matrix33, Point, Rect};
use dolce_smufl::MetaData;
use dolce_text::{syllable::syllable_run, CompressMode, Font, MeasureCtx};

use crate::{LineShape, Node, PathOp, PathSeg, PathShape, Role, Shape, SmuflShape, TextShape};

/// 构建期要的外部件：量字上下文与 SMuFL 元数据（SMuFL 字的紧包围盒）。
#[derive(Clone, Copy)]
pub struct Env<'a> {
    pub mc: &'a MeasureCtx<'a>,
    pub meta: Option<&'a MetaData>,
}

/// 取盒失败（同 TS 抛的那句）。
#[derive(Clone, Debug, PartialEq)]
pub struct SceneError(pub String);

impl std::fmt::Display for SceneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for SceneError {}

// ───────────────────────── 造节点 ─────────────────────────

impl Node {
    pub fn new(shape: Shape) -> Node {
        Node {
            shape,
            role: None,
            m: Matrix33::IDENTITY,
            w: 0.0,
            h: 0.0,
            b: None,
            cls: Vec::new(),
            id: None,
            sel: false,
            data: None,
            k: Vec::new(),
        }
    }
    /// `new Group()`
    pub fn group() -> Node {
        Node::new(Shape::Group)
    }
    /// `new PageItem()`
    pub fn item() -> Node {
        Node::new(Shape::Item)
    }
    /// `new GraphicPath()`：线宽 1、颜色 0、不描不填
    pub fn path() -> Node {
        Node::new(Shape::Path(PathShape { segs: Vec::new(), stroke_width: 1.0, stroke_color: 0.0, fill_color: 0.0, stroke: false, fill: false }))
    }
    /// `new GraphicLine()`：两端 (0,0)、线宽 1、颜色 0
    pub fn line() -> Node {
        Node::new(Shape::Line(LineShape { p0: Point::default(), p1: Point::default(), stroke_width: 1.0, stroke_color: 0.0 }))
    }
    /// `new TextFrame()` 再设字、字体（缺省黑色）
    pub fn text(text: impl Into<String>, font: Font) -> Node {
        Node::new(Shape::Text(TextShape { text: text.into(), font, color: colors::BLACK, char_xs: None, ink_bound: false }))
    }
    /// `new SmuflText(..)` 再设字
    pub fn smufl(text: impl Into<String>, font: Font) -> Node {
        Node::new(Shape::Smufl(SmuflShape {
            text: TextShape { text: text.into(), font, color: colors::BLACK, char_xs: None, ink_bound: false },
            as_path: false,
        }))
    }

    pub fn set_x(&mut self, v: f64) {
        self.m.mat[2] = v;
    }
    pub fn set_y(&mut self, v: f64) {
        self.m.mat[5] = v;
    }
    /// `classes.add`（有序集合：已有的不重复加）
    pub fn add_class(&mut self, c: &str) {
        if !self.has_class(c) {
            self.cls.push(c.to_string());
        }
    }
    /// `add`
    pub fn push(&mut self, child: Node) {
        self.k.push(child);
    }
    pub fn path_ref(&self) -> Option<&PathShape> {
        match &self.shape {
            Shape::Path(p) => Some(p),
            _ => None,
        }
    }
    pub fn path_mut(&mut self) -> &mut PathShape {
        match &mut self.shape {
            Shape::Path(p) => p,
            _ => panic!("不是路径节点"),
        }
    }
    pub fn line_mut(&mut self) -> &mut LineShape {
        match &mut self.shape {
            Shape::Line(l) => l,
            _ => panic!("不是线节点"),
        }
    }
    pub fn line_ref(&self) -> Option<&LineShape> {
        match &self.shape {
            Shape::Line(l) => Some(l),
            _ => None,
        }
    }
    /// 文字（含 SMuFL 字）
    pub fn text_ref(&self) -> Option<&TextShape> {
        match &self.shape {
            Shape::Text(t) | Shape::Smufl(SmuflShape { text: t, .. }) => Some(t),
            _ => None,
        }
    }
    pub fn text_mut(&mut self) -> &mut TextShape {
        match &mut self.shape {
            Shape::Text(t) | Shape::Smufl(SmuflShape { text: t, .. }) => t,
            _ => panic!("不是文字节点"),
        }
    }
    /// 平移 `x += dx, y += dy`（TS 的 `it.x -= …` 一类）
    pub fn shift(&mut self, dx: f64, dy: f64) {
        self.m.mat[2] += dx;
        self.m.mat[5] += dy;
    }
    /// `instanceof Group`
    pub fn is_group_like(&self) -> bool {
        matches!(self.shape, Shape::Group)
    }
}

impl PathShape {
    pub fn move_to(&mut self, x: f64, y: f64) {
        self.segs.push(PathSeg { op: PathOp::M, pts: vec![x, y] });
    }
    pub fn line_to(&mut self, x: f64, y: f64) {
        self.segs.push(PathSeg { op: PathOp::L, pts: vec![x, y] });
    }
    pub fn move_to_p(&mut self, p: Point) {
        self.move_to(p.x, p.y);
    }
    pub fn line_to_p(&mut self, p: Point) {
        self.line_to(p.x, p.y);
    }
    pub fn cubic_to(&mut self, x1: f64, y1: f64, x2: f64, y2: f64, x3: f64, y3: f64) {
        self.segs.push(PathSeg { op: PathOp::C, pts: vec![x1, y1, x2, y2, x3, y3] });
    }
    pub fn cubic_to_p(&mut self, p1: Point, p2: Point, p3: Point) {
        self.cubic_to(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
    }
    pub fn close(&mut self) {
        self.segs.push(PathSeg { op: PathOp::Z, pts: Vec::new() });
    }
    /// 所有坐标平移
    pub fn offset(&mut self, dx: f64, dy: f64) {
        for s in &mut self.segs {
            let mut i = 0;
            while i + 1 < s.pts.len() {
                s.pts[i] += dx;
                s.pts[i + 1] += dy;
                i += 2;
            }
        }
    }
    /// `computeTightBounds`：空路径给空盒，否则按 `d` 量（量字层缓存，键即 `d`）
    pub fn tight_bounds(&self, mc: &MeasureCtx) -> Rect {
        if self.segs.is_empty() {
            return Rect::default();
        }
        mc.path_tight_bounds(&self.d())
    }
}

impl TextShape {
    /// `measureText()`：整串 advance
    pub fn measure(&self, mc: &MeasureCtx) -> f64 {
        self.font.measure_text(mc, &self.text)
    }
}

// ───────────────────────── 盒 ─────────────────────────

/// UTF-16 首个码元那个字（TS `text[0]`；非 BMP 字 TS 取到的是孤立高代理，这里取整个字——
/// 量字键不同，迁移期回放会报未录到，碰上再说）。空串给空串。
fn first_unit(s: &str) -> &str {
    s.char_indices().nth(1).map_or(s, |(i, _)| &s[..i])
}

/// TS `bound` getter。SMuFL 字取不到盒（码位不认识、元数据里没有）时为 `None`。
pub fn bound(n: &Node, env: &Env) -> Option<Rect> {
    match &n.shape {
        Shape::Group | Shape::Item | Shape::Line(_) => Some(Rect::wh(n.w, n.h)),
        Shape::Path(_) => match n.role {
            Some(Role::JpOctaveDot { radius, .. }) => Some(Rect::wh(2.0 * radius, 2.0 * radius)),
            _ => Some(Rect::wh(n.w, n.h)),
        },
        Shape::Text(t) => {
            if let Some(Role::JpNumber { .. }) = n.role {
                let b = t.font.char_bound(env.mc, first_unit(&t.text));
                return Some(Rect::new(0.0, b.top, n.w, b.bottom));
            }
            if t.ink_bound {
                let b = t.font.char_bound(env.mc, &t.text);
                return Some(Rect::new(0.0, dolce_base::js::min(b.top, 0.0), n.w, dolce_base::js::max(b.bottom, 0.0)));
            }
            let fm = t.font.metrics(env.mc);
            Some(Rect::new(0.0, fm.ascent, n.w, fm.descent))
        }
        Shape::Smufl(s) => {
            let c = s.text.text.chars().next()?;
            let bb = env.meta?.bbox(c).ok()??;
            let sp = s.text.font.size / 4.0;
            Some(Rect::new(bb.sw[0] * sp, -bb.ne[1] * sp, bb.ne[0] * sp, -bb.sw[1] * sp))
        }
    }
}

fn bound_or_err(n: &Node, env: &Env) -> Result<Rect, SceneError> {
    bound(n, env).ok_or_else(|| {
        let c = n.text_ref().and_then(|t| t.text.chars().next());
        match c.map(dolce_smufl::glyph_code_name) {
            Some(None) => SceneError(dolce_smufl::UnknownGlyph(c.unwrap()).to_string()),
            _ => SceneError("no smufl bbox".into()),
        }
    })
}

/// TS `childrenBound`：子级是组的取它的 `childrenBound`，否则取 `bound`，各按子级平移后并起来。
pub fn children_bound(n: &Node, env: &Env) -> Result<Rect, SceneError> {
    let mut r = Rect::default();
    for ch in &n.k {
        let rr = if ch.is_group_like() { children_bound(ch, env)? } else { bound_or_err(ch, env)? };
        r = r.union(&rr.offset(ch.x(), ch.y()));
    }
    Ok(r)
}

// ───────────────────────── update ─────────────────────────

/// TS `update()`，按形与角色分派。
pub fn update(n: &mut Node, env: &Env) -> Result<(), SceneError> {
    match &n.shape {
        Shape::Item => {
            // `PageItem.update`：宽高取到子级盒并集的右下角（不归一）
            let mut r = Rect::default();
            for ch in &mut n.k {
                update(ch, env)?;
                r = r.union(&bound_or_err(ch, env)?.offset(ch.x(), ch.y()));
            }
            n.w = r.right;
            n.h = r.bottom;
        }
        Shape::Group => {
            for ch in &mut n.k {
                update(ch, env)?;
            }
            let bnd = children_bound(n, env)?;
            for ch in &mut n.k {
                ch.shift(-bnd.left, -bnd.top);
            }
            n.shift(bnd.left, bnd.top);
            n.w = bnd.width();
            n.h = bnd.height();
        }
        Shape::Path(p) => {
            if let Some(Role::JpOctaveDot { radius, .. }) = n.role {
                n.w = 2.0 * radius;
                n.h = 2.0 * radius;
                return Ok(());
            }
            let bnd = p.tight_bounds(env.mc);
            n.w = bnd.width();
            n.h = bnd.height();
            n.shift(bnd.left, bnd.top);
            n.path_mut().offset(-bnd.left, -bnd.top);
        }
        Shape::Line(l) => {
            let (p0, p1, sw) = (l.p0, l.p1, l.stroke_width);
            n.shift(p0.x, p0.y);
            let p1 = Point::new(p1.x - p0.x, p1.y - p0.y);
            let p0 = Point::new(0.0, 0.0);
            n.w = p1.x.abs();
            n.h = p1.y.abs();
            if p0.x == p1.x {
                n.w = sw;
            }
            if p0.y == p1.y {
                n.h = sw;
            }
            let l = n.line_mut();
            l.p0 = p0;
            l.p1 = p1;
        }
        Shape::Text(_) | Shape::Smufl(_) => match n.role.clone() {
            Some(Role::Lyric { verse, compress, .. }) => {
                let t = n.text_ref().unwrap();
                let run = syllable_run(&t.text, &t.font, env.mc, CompressMode::parse(&compress));
                let size = t.font.size;
                n.text_mut().char_xs = run.xs;
                n.role = Some(Role::Lyric { widths: [run.lead, run.body, run.tail], compress, verse });
                n.w = run.width;
                n.h = size;
            }
            role => {
                let t = n.text_ref().unwrap();
                let extra = match role {
                    Some(Role::JpNumber { aug_dot_advance, .. }) => aug_dot_advance,
                    _ => 0.0,
                };
                // TS：先 `width = measureText()`，数字再加附点留的宽
                let (w, h) = (t.measure(env.mc), t.font.size);
                n.w = w + extra;
                n.h = h;
            }
        },
    }
    Ok(())
}

/// 冻结：每个节点记下 `bound`（取不到的记 None），同 TS 参考导出的口径。
pub fn freeze(n: &mut Node, env: &Env) {
    n.b = bound(n, env);
    for c in &mut n.k {
        freeze(c, env);
    }
}

/// `Group.normalizeX/Y`：子级里最小的 x（y）挪到组上。空组不动。
pub fn normalize_x(n: &mut Node) {
    let Some(mx) = n.k.iter().map(Node::x).reduce(|m, x| if x < m { x } else { m }) else { return };
    for c in &mut n.k {
        c.shift(-mx, 0.0);
    }
    n.shift(mx, 0.0);
}
pub fn normalize_y(n: &mut Node) {
    let Some(my) = n.k.iter().map(Node::y).reduce(|m, y| if y < m { y } else { m }) else { return };
    for c in &mut n.k {
        c.shift(0.0, -my);
    }
    n.shift(0.0, my);
}

/// `changeColor`：子级先、自己后；路径只改开着的那一项，文字改字色，线改线色。
pub fn change_color(n: &mut Node, clr: f64) {
    for c in &mut n.k {
        change_color(c, clr);
    }
    match &mut n.shape {
        Shape::Path(p) => {
            if p.stroke {
                p.stroke_color = clr;
            }
            if p.fill {
                p.fill_color = clr;
            }
        }
        Shape::Line(l) => l.stroke_color = clr,
        Shape::Text(t) | Shape::Smufl(SmuflShape { text: t, .. }) => t.color = clr,
        Shape::Group | Shape::Item => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dolce_text::ReplayMeasurer;

    #[test]
    fn group_update_normalizes() {
        let r = ReplayMeasurer::from_jsonl(r#"{"op":"pathBounds","d":"M2 3 L7 9","bbox":[2,3,7,9]}"#).unwrap();
        let mc = MeasureCtx::new(&r);
        let env = Env { mc: &mc, meta: None };
        let mut g = Node::group();
        let mut p = Node::path();
        p.path_mut().move_to(2.0, 3.0);
        p.path_mut().line_to(7.0, 9.0);
        g.push(p);
        let mut l = Node::line();
        l.line_mut().p0 = Point::new(10.0, 5.0);
        l.line_mut().p1 = Point::new(20.0, 5.0);
        l.line_mut().stroke_width = 2.0;
        g.push(l);
        update(&mut g, &env).unwrap();
        assert_eq!((g.x(), g.y(), g.w, g.h), (2.0, 3.0, 18.0, 6.0));
        assert_eq!((g.k[0].x(), g.k[0].y()), (0.0, 0.0));
        assert_eq!(g.k[0].path_ref().unwrap().segs[1].pts, vec![5.0, 6.0]);
        assert_eq!((g.k[1].x(), g.k[1].y(), g.k[1].w, g.k[1].h), (8.0, 2.0, 10.0, 2.0));
        assert!(r.misses().is_empty());
    }
}
