//! 取数层交出的纯数据（与 PDFium 无关，可序列化、可跨线程）。
//!
//! **坐标一律是页面点、左上原点、y 向下**（PDF 原生是左下原点 y 向上，取数时翻好）。
//! 矩阵 `[a, b, c, d, e, f]` 也已换到这个坐标系：点 (u, v) 映到 (a·u + c·v + e, b·u + d·v + f)。
use dolce_omr_core::image::Rect;
use serde::{Deserialize, Serialize};

/// 一页的内容。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PageContent {
    /// 页面尺寸（点）。
    pub width: f64,
    pub height: f64,
    pub images: Vec<PageImage>,
    pub paths: Vec<PathObj>,
    pub chars: Vec<TextChar>,
}

/// 内嵌图在 PDF 里的色彩形态（位图识别据此选二值化办法）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ImageKind {
    /// 1 位（CCITT、JBIG2、1 位 Flate、图像掩膜）
    Mask,
    /// 8 位灰度
    Gray,
    /// 彩色（RGB / CMYK，已转成 RGB）
    Color,
}

/// 一块内嵌图：**原始尺寸、不重采样**的像素 + 它在页上的位置。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PageImage {
    /// 像素尺寸。
    pub w: usize,
    pub h: usize,
    pub kind: ImageKind,
    /// 灰度像素（0 黑、255 白），`w * h`。彩色图另有 `rgb`，这里是它的亮度。
    pub gray: Vec<u8>,
    /// 彩色图的 RGB（`w * h * 3`）；不是彩色为空。
    pub rgb: Vec<u8>,
    /// 图像空间（单位正方形，(0,0) 是图的左上角）→ 页面坐标的矩阵。
    pub ctm: [f64; 6],
    /// 页上的外框。
    pub rect: Rect,
    /// PDF 里的位深与过滤器名（排查用）。
    pub bpp: u32,
    pub filters: Vec<String>,
}

/// 路径的一段。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub enum Seg {
    Move(f64, f64),
    Line(f64, f64),
    /// 三次贝塞尔：两个控制点 + 终点。
    Cubic(f64, f64, f64, f64, f64, f64),
    Close,
}

/// 一个路径对象（已乘上自身与所在 Form 的矩阵，坐标是页面点）。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PathObj {
    pub segs: Vec<Seg>,
    /// 填充色（RGBA）；不填为 None。
    pub fill: Option<[u8; 4]>,
    /// 描边色；不描为 None。
    pub stroke: Option<[u8; 4]>,
    /// 线宽（页面点，已按矩阵缩放）。
    pub line_width: f64,
    /// 奇偶填充规则（否则非零环绕）。
    pub even_odd: bool,
    pub dashed: bool,
    pub bbox: Rect,
}

/// 文字层的一个字。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TextChar {
    /// Unicode（PDFium 经 ToUnicode / 编码表映出来的；映不出时是字符码本身）。
    pub unicode: u32,
    /// 字体名（去掉子集前缀 `ABCDEF+`）。
    pub font: String,
    /// 是否子集嵌入的字体（名字带子集前缀）。
    pub subset: bool,
    /// 字号（文字空间，未乘矩阵的竖向缩放）与实际字高（乘过的）。
    pub size: f64,
    pub size_scaled: f64,
    /// 基线原点（页面点）。
    pub origin: (f64, f64),
    /// 墨迹框（PDFium 给的紧框）。
    pub bbox: Rect,
    /// PDFium 为拼行补出的字（空格、换行），不是 PDF 里画的。
    pub generated: bool,
    /// 字形轮廓（页面点）；取不到为 None（如子集字体里没有 Unicode 映射的码位，退路见模块页）。
    pub outline: Option<Vec<Seg>>,
}

impl PageContent {
    /// 只留中心落在 `rect` 里、不落在 `drop` 任一框里的路径、字与图（页面点）。歌本逐首识别按段取一页的一截用；页面尺寸不变。
    pub fn clip(&self, rect: &Rect, drop: &[Rect]) -> PageContent {
        let inside = |r: &Rect, x: f64, y: f64| x >= r.x && x <= r.right() && y >= r.y && y <= r.bottom();
        let keep = |b: &Rect| inside(rect, b.cx(), b.cy()) && !drop.iter().any(|d| inside(d, b.cx(), b.cy()));
        PageContent {
            width: self.width,
            height: self.height,
            images: self.images.iter().filter(|o| keep(&o.rect)).cloned().collect(),
            paths: self.paths.iter().filter(|o| keep(&o.bbox)).cloned().collect(),
            chars: self.chars.iter().filter(|o| keep(&o.bbox)).cloned().collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(x: f64, y: f64) -> PathObj {
        PathObj { segs: vec![], fill: None, stroke: None, line_width: 1.0, even_odd: false, dashed: false, bbox: Rect::new(x, y, 2.0, 2.0) }
    }

    #[test]
    fn clip_by_center() {
        let pc = PageContent { width: 100.0, height: 100.0, images: vec![], paths: vec![path(10.0, 10.0), path(10.0, 50.0), path(10.0, 90.0)], chars: vec![] };
        let c = pc.clip(&Rect::new(0.0, 0.0, 100.0, 60.0), &[Rect::new(0.0, 45.0, 30.0, 10.0)]);
        assert_eq!(c.paths.len(), 1);
        assert_eq!(c.paths[0].bbox.y, 10.0);
    }
}
