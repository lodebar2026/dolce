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
    let mut out = Vec::new();
    for o in vp.objs.iter().filter(|o| o.kind == VKind::Glyph && matches!(o.src, dolce_omr_source::vector::ObjSrc::Path(_)) && o.twin_of.is_none()) {
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

/// 转曲页的音乐字形：字形块跨字体认身份（1 em = 4 线距）；认不出的回 `name` 为空串（多半是文字，交给读字那一路）。
pub fn path_glyphs(pieces: &[GlyphPiece], space: f64) -> Vec<VSym> {
    let em = 4.0 * space;
    pieces
        .iter()
        .map(|p| {
            let (name, dist) = dolce_omr_sheet::shapes::identify_outline(&p.rings, (p.rect.w / em, p.rect.h / em)).unwrap_or(("", u32::MAX));
            VSym { obj: p.obj, name, rect: p.rect, dist, em, curved: p.curved }
        })
        .collect()
}
