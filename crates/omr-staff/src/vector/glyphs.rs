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
fn raw_bounds(segs: &[Seg], vp: &VecPage) -> Option<(f64, f64, f64, f64)> {
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
    for o in vp.objs.iter().filter(|o| o.kind == VKind::Glyph) {
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
