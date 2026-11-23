//! 矢量页的**块原语与身份**：文字层里音乐字体的字（以后加转曲路径的字形块）→ 带 SMuFL 名的符号。
//! 身份一律经 `omr-sheet::shapes::identify`（签名字典 + 码位表），这里只管取轮廓与尺寸。
use dolce_omr_core::image::Rect;
use dolce_omr_sheet::shapes::{identify, Family};
use dolce_omr_source::model::Seg;
use dolce_omr_source::vector::{VKind, VecPage};

pub use dolce_omr_sheet::shapes::music_family;

/// 一个认出身份的字形（工作坐标）。
#[derive(Clone, Debug)]
pub struct VSym {
    /// 对象号（`Evidence::Vector`）。
    pub obj: u32,
    pub name: &'static str,
    /// 墨迹框。
    pub rect: Rect,
    /// 签名距离（码位表命中记签名上限）。
    pub dist: u32,
    /// 字号（工作单位）。
    pub em: f64,
    /// 对象有曲线段（点是圆的；横杠、竖笔没有）。
    pub curved: bool,
}

impl VSym {
    pub fn cx(&self) -> f64 {
        self.rect.x + self.rect.w / 2.0
    }
    pub fn cy(&self) -> f64 {
        self.rect.y + self.rect.h / 2.0
    }
}

/// 轮廓的全部坐标（含控制点）的外框（工作坐标）。
pub(crate) fn raw_bounds(segs: &[Seg], vp: &VecPage) -> Option<(f64, f64, f64, f64)> {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    let mut take = |x: f64, y: f64| {
        let (x, y) = ((x - vp.origin.0) * vp.scale, (y - vp.origin.1) * vp.scale);
        x0 = x0.min(x);
        x1 = x1.max(x);
        y0 = y0.min(y);
        y1 = y1.max(y);
    };
    for s in segs {
        match *s {
            Seg::Move(x, y) | Seg::Line(x, y) => take(x, y),
            Seg::Cubic(a, b, c, d, x, y) => {
                take(a, b);
                take(c, d);
                take(x, y);
            }
            Seg::Close => {}
        }
    }
    (x0 <= x1).then_some((x0, y0, x1, y1))
}

/// 一页文字层里音乐字体的字（认不出身份的也回，`name` 为空串）。
pub fn music_chars(vp: &VecPage) -> Vec<VSym> {
    let mut out = Vec::new();
    // 化成了线对象的字（谱线、符干、小节线，打击乐谱号的两道粗竖条）也认身份：谱号要它
    for o in vp.objs.iter().filter(|o| o.kind == VKind::Glyph || o.kind == VKind::Line && matches!(o.src, dolce_omr_source::vector::ObjSrc::Char(_))) {
        let Some(c) = vp.char_of(o) else { continue };
        let Some(fam) = music_family(&c.font) else { continue };
        let size = (c.size_scaled > 0.0).then(|| (c.bbox.w / c.size_scaled, c.bbox.h / c.size_scaled));
        let bounds = c.outline.as_deref().and_then(|s| raw_bounds(s, vp));
        let rings: &[Vec<(f64, f64)>] = if c.outline.is_some() { &o.rings } else { &[] };
        let (name, dist) = identify(rings, bounds, size, c.unicode, Some(fam)).unwrap_or(("", u32::MAX));
        out.push(VSym { obj: o.id, name, rect: vp.rect_of(&c.bbox), dist, em: c.size_scaled * vp.scale, curved: o.curved });
    }
    out
}

/// 认出的家族（排查用）。
pub fn family_of(vp: &VecPage, s: &VSym) -> Option<Family> {
    vp.char_of(&vp.objs[s.obj as usize]).and_then(|c| music_family(&c.font))
}

pub use dolce_omr_source::vector::{path_pieces, GlyphPiece};

/// 转曲页的音乐字形：字形块跨字体认身份（1 em = 4 线距）；认不出的回 `name` 为空串（多半是文字，交给读字那一路）。
/// 形状简单（一道横、一点、一竖、两竖）的符号从一个对象拆出来的块认成它们不算数（「到」「判」的立刀两竖认成打击乐谱号，
/// 后面整段音读成打击乐）；圆点组成的字形，没有曲线的对象不认（还原号拆出来的两道横杠认成反复记号两点）。照 TS 转曲那一路。
/// 签名的归一外框同字典建库（与 TS 转曲那一路同口径）：按路径的全部坐标（含曲线控制点）取；有的排版软件转曲后一个符头只用两段三次曲线画椭圆
/// （CorelDRAW），控制点远在曲线外，控制点外框比曲线外框大出 [`CTRL_SLACK`] 以上时改按曲线外框取。从一个对象拆出来的块没有单独的控制点，按曲线外框取。
pub fn path_glyphs(pieces: &[GlyphPiece], space: f64, vp: &VecPage, pc: &dolce_omr_source::PageContent) -> Vec<VSym> {
    let em = 4.0 * space;
    let mut per_obj: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    for p in pieces {
        *per_obj.entry(p.obj).or_default() += 1;
    }
    let ctrl = |p: &GlyphPiece| -> Option<(f64, f64, f64, f64)> {
        if per_obj[&p.obj] != 1 {
            return None;
        }
        let dolce_omr_source::vector::ObjSrc::Path(pi) = vp.objs[p.obj as usize].src else { return None };
        let b = raw_bounds(&pc.paths.get(pi)?.segs, vp)?;
        let (bw, bh) = (b.2 - b.0, b.3 - b.1);
        (bw <= p.rect.w.max(1e-9) * (1.0 + CTRL_SLACK) && bh <= p.rect.h.max(1e-9) * (1.0 + CTRL_SLACK)).then_some(b)
    };
    pieces
        .iter()
        .map(|p| {
            let (mut name, dist) = dolce_omr_sheet::shapes::identify_outline_in(&p.rings, (p.rect.w / em, p.rect.h / em), ctrl(p)).unwrap_or(("", u32::MAX));
            if per_obj[&p.obj] > 1 && PLAIN_SHAPES.contains(&name) || DOT_SHAPES.contains(&name) && !p.curved {
                name = "";
            }
            VSym { obj: p.obj, name, rect: p.rect, dist, em, curved: p.curved }
        })
        .collect()
}

const CTRL_SLACK: f64 = 0.05;

/// 转曲页画成细长曲线对象的字形（八分休止、符尾：对象库按形状归成曲线，不进字形块）：一个对象当一块认身份，只收认得出的。
pub fn curve_glyphs(vp: &VecPage, space: f64, pc: &dolce_omr_source::PageContent, skip: &dyn Fn(&Rect) -> bool) -> Vec<VSym> {
    use dolce_omr_source::vector::{ObjSrc, VKind};
    let pieces: Vec<GlyphPiece> = vp
        .objs
        .iter()
        .filter(|o| o.kind == VKind::Curve && matches!(o.src, ObjSrc::Path(_)) && o.twin_of.is_none() && !skip(&o.rect))
        .map(|o| GlyphPiece { obj: o.id, rings: o.rings.clone(), rect: o.rect, curved: true })
        .collect();
    path_glyphs(&pieces, space, vp, pc).into_iter().filter(|s| CURVE_SHAPES.contains(&s.name)).collect()
}

/// 曲线对象里只收这几种（弧、延长记号的拱另有一路）。
const CURVE_SHAPES: &[&str] = &["rest8th", "rest16th", "rest32nd", "flag8thUp", "flag8thDown", "flag16thUp", "flag16thDown", "flag32ndUp", "flag32ndDown"];

const PLAIN_SHAPES: &[&str] = &[
    "articTenutoAbove", "articTenutoBelow", "legerLine", "stem", "augmentationDot", "articStaccatoAbove", "articStaccatoBelow",
    "barlineSingle", "barlineDouble", "restHBar", "unpitchedPercussionClef1", "unpitchedPercussionClef2",
];
const DOT_SHAPES: &[&str] = &["repeatDots", "augmentationDot"];

/// 按实心符头认空心符头（转曲页）：字典里各字体的二分符头内腔斜着，有的书画成同心两个椭圆（裴克经文诗歌），签名对不上。
/// 本页已认出至少 [`HEAD_MIN`] 个实心符头时，认不出的块里外框高与实心头中位相当、两道环套在一起（外圈与内腔）的是空心符头，
/// 宽到实心头 [`WHOLE_W`] 倍上下的是全音符。原样照 TS 转曲那一路。
/// `zone`：只收谱表区里的块（版权行的「©」也是两道环套着）。
pub fn hollow_heads(pieces: &[GlyphPiece], syms: &mut [VSym], zone: &dyn Fn(&Rect) -> bool) {
    let solid: Vec<&VSym> = syms.iter().filter(|s| s.name == "noteheadBlack").collect();
    if solid.len() < HEAD_MIN {
        return;
    }
    let mw = dolce_omr_core::geom::median(&solid.iter().map(|s| s.rect.w).collect::<Vec<_>>(), 0.0);
    let mh = dolce_omr_core::geom::median(&solid.iter().map(|s| s.rect.h).collect::<Vec<_>>(), 0.0);
    if mw <= 0.0 || mh <= 0.0 {
        return;
    }
    let mut per_obj: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    for p in pieces {
        *per_obj.entry(p.obj).or_default() += 1;
    }
    for (p, s) in pieces.iter().zip(syms.iter_mut()) {
        // 整个对象就这一块（字里拆出来的「口」「o」不算）
        if !s.name.is_empty() || per_obj[&p.obj] != 1 || p.rings.len() != 2 || !nested(&p.rings) || !zone(&p.rect) {
            continue;
        }
        let (rw, rh) = (p.rect.w / mw, p.rect.h / mh);
        if (rh - 1.0).abs() > HEAD_TOL || rw < 1.0 - HEAD_TOL || rw > WHOLE_W + HEAD_TOL {
            continue;
        }
        s.name = if rw > WHOLE_W - HEAD_TOL { "noteheadWhole" } else { "noteheadHalf" };
        s.dist = 0;
    }
}

/// 两道环一个整个在另一个的外框里。
fn nested(rings: &[Vec<(f64, f64)>]) -> bool {
    let bx = |r: &Vec<(f64, f64)>| r.iter().fold((f64::MAX, f64::MAX, f64::MIN, f64::MIN), |a, &(x, y)| (a.0.min(x), a.1.min(y), a.2.max(x), a.3.max(y)));
    let (a, b) = (bx(&rings[0]), bx(&rings[1]));
    let inside = |i: (f64, f64, f64, f64), o: (f64, f64, f64, f64)| i.0 >= o.0 && i.1 >= o.1 && i.2 <= o.2 && i.3 <= o.3;
    inside(a, b) || inside(b, a)
}

/// 按实心符头认空心符头：本页至少认出几个实心符头、外框差多少以内；全音符比实心符头宽这么多倍
///（裴克经文诗歌的全音符 1.99 格宽、实心符头 1.28 格，1.55 倍；各字体在 1.4~1.6 倍之间）。
const HEAD_MIN: usize = 3;
const HEAD_TOL: f64 = 0.15;
const WHOLE_W: f64 = 1.5;

/// 按**矢量结构**认升降还原号（转曲页：竖笔是线对象，升号、还原号的横杠是无曲线的填充块，降号的肚子是带曲线的块，三者分开、字典认不出）。
/// 照 TS 转曲那一路（`accidentalByStrokes`）：
/// - 两道竖笔夹着无曲线的横杠：两笔上下错开（左笔朝上伸、右笔朝下伸，错开过笔长 [`NATURAL_STAGGER`]）是还原号，否则是升号；
/// - 一道竖笔在带曲线的肚子左半边、肚子底与竖笔下端差不过笔长 [`FLAT_FOOT`]、竖笔上端高出肚子顶过笔长 [`FLAT_FOOT`]：降号
///   （倚音的符尾挂在符干上端往下弯，不是）。
///
/// 竖笔长 1.5~3.3 格（同位图路调号的竖笔窗）。`skip`：不收的框（简谱带里的）。已有同位置升降号字形的不重复出。
pub fn stroke_accidentals(vp: &VecPage, space: f64, have: &[VSym], skip: &dyn Fn(&Rect) -> bool) -> Vec<VSym> {
    use dolce_omr_source::vector::VKind;
    let sp = space;
    let strokes: Vec<(f64, f64, f64, u32)> = vp
        .lines
        .iter()
        .filter(|l| l.is_v() && l.len() >= sp * 1.5 && l.len() <= sp * 3.3 && l.w <= sp * 0.4)
        .map(|l| ((l.a.0 + l.b.0) / 2.0, l.a.1.min(l.b.1), l.a.1.max(l.b.1), l.obj))
        .collect();
    let taken = |r: &Rect| have.iter().any(|h| h.name.starts_with("accidental") && h.rect.x < r.right() && r.x < h.rect.right() && h.rect.y < r.bottom() && r.y < h.rect.bottom());
    let near = |r: &Rect| -> Vec<(f64, f64, f64, u32)> {
        strokes.iter().copied().filter(|&(x, y0, y1, _)| x >= r.x - sp * 0.25 && x <= r.right() + sp * 0.25 && y0 < r.bottom() && y1 > r.y).collect()
    };
    let mut out: Vec<VSym> = Vec::new();
    let mut pairs: Vec<(u32, u32)> = Vec::new();
    for o in vp.objs.iter().filter(|o| o.twin_of.is_none() && matches!(o.src, dolce_omr_source::vector::ObjSrc::Path(_))) {
        let r = o.rect;
        // 横梁框高放到 2 格：转曲字体的升号横梁斜得陡，两道合起来 1.7 格高（裴克经文诗歌 181）；仍要两根竖笔夹着
        if r.w > sp * 1.5 || r.h > sp * 2.0 || skip(&r) {
            continue;
        }
        let ss = near(&r);
        let sym = if !o.curved && o.kind == VKind::Poly && ss.len() == 2 {
            let (a, b) = if ss[0].0 <= ss[1].0 { (ss[0], ss[1]) } else { (ss[1], ss[0]) };
            let gap = b.0 - a.0;
            if gap < sp * 0.3 || gap > sp * 1.2 || pairs.contains(&(a.3, b.3)) {
                continue;
            }
            pairs.push((a.3, b.3));
            let h = (a.2 - a.1).max(b.2 - b.1);
            let name = if b.1 - a.1 > h * NATURAL_STAGGER { "accidentalNatural" } else { "accidentalSharp" };
            let (x0, y0) = (a.0.min(r.x), a.1.min(b.1).min(r.y));
            let (x1, y1) = (b.0.max(r.right()), a.2.max(b.2).max(r.bottom()));
            (name, Rect::new(x0, y0, x1 - x0, y1 - y0))
        } else if o.curved && ss.len() == 1 && r.w <= sp * 1.2 && ss[0].0 < r.x + r.w / 2.0 {
            let (x, y0, y1, _) = ss[0];
            let len = y1 - y0;
            if (r.bottom() - y1).abs() >= len * FLAT_FOOT || r.y - y0 <= len * FLAT_FOOT {
                continue;
            }
            let x0 = x.min(r.x);
            ("accidentalFlat", Rect::new(x0, y0, r.right() - x0, r.bottom().max(y1) - y0))
        } else {
            continue;
        };
        if taken(&sym.1) {
            continue;
        }
        out.push(VSym { obj: o.id, name: sym.0, rect: sym.1, dist: 0, em: 4.0 * sp, curved: o.curved });
    }
    out
}

/// 降号肚子底与竖笔下端差不过笔长的这么多、竖笔上端高出肚子顶至少这么多（裴克经文诗歌：差 0.02、高出 0.45）。
const FLAT_FOOT: f64 = 0.2;
/// 还原号两道竖笔上下错开至少笔长的这么多（裴克经文诗歌还原号 0.33、升号 0.07）。
const NATURAL_STAGGER: f64 = 0.2;
