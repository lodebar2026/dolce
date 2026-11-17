//! 排版的几何地基，照 `src/common/geom.ts` 与 `src/common/pathbounds.ts`。
//!
//! 口径与 TS 逐字相同要守的几处：
//! - [`Rect::union`]：自己是空盒（`left >= right || top >= bottom`）时直接取对方，**不**取并——
//!   零高的墨迹盒（一道横线）与别的盒合并时会被整个丢掉，TS 就是这样，照搬；
//! - [`Matrix33`] 行主序 9 元（`scaleX skewX transX / skewY scaleY transY / 0 0 1`），
//!   `isIdentity` 只看前 6 元，`toSvg` 按 `a b c d e f` 次序写、数按 JS `String(number)`；
//! - 颜色是 ARGB 整数，按 `>>>` 取各分量（负数、超 2^32 的都按 ToUint32 回绕）。

use dolce_base::js::{num_to_string, to_fixed};
use serde::{Deserialize, Serialize};

mod pathbounds;
pub use pathbounds::path_bounds;

/// `Math.fround`：取到最近的 f32 再回 f64（原生量字的结果都过一道，同 TS `f32`）。
#[inline]
pub fn fround(x: f64) -> f64 {
    x as f32 as f64
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(from = "[f64; 2]", into = "[f64; 2]")]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl From<[f64; 2]> for Point {
    fn from(a: [f64; 2]) -> Self {
        Point { x: a[0], y: a[1] }
    }
}
impl From<Point> for [f64; 2] {
    fn from(p: Point) -> Self {
        [p.x, p.y]
    }
}

impl Point {
    pub const fn new(x: f64, y: f64) -> Point {
        Point { x, y }
    }
    pub fn offset(self, dx: f64, dy: f64) -> Point {
        Point::new(self.x + dx, self.y + dy)
    }
    pub fn rotate(self, cos: f64, sin: f64) -> Point {
        Point::new(self.x * cos + self.y * sin, self.y * cos - self.x * sin)
    }
}

/// 矩形（`left, top, right, bottom`；y 向下）。JSON 里写成 `[l, t, r, b]`。
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(from = "[f64; 4]", into = "[f64; 4]")]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl From<[f64; 4]> for Rect {
    fn from(a: [f64; 4]) -> Self {
        Rect::new(a[0], a[1], a[2], a[3])
    }
}
impl From<Rect> for [f64; 4] {
    fn from(r: Rect) -> Self {
        [r.left, r.top, r.right, r.bottom]
    }
}

impl Rect {
    pub const fn new(left: f64, top: f64, right: f64, bottom: f64) -> Rect {
        Rect { left, top, right, bottom }
    }
    pub const fn wh(w: f64, h: f64) -> Rect {
        Rect::new(0.0, 0.0, w, h)
    }
    pub fn width(&self) -> f64 {
        self.right - self.left
    }
    pub fn height(&self) -> f64 {
        self.bottom - self.top
    }
    /// `left >= right || top >= bottom`（NaN 不算空，同 TS）
    pub fn is_empty(&self) -> bool {
        self.left >= self.right || self.top >= self.bottom
    }
    pub fn offset(&self, dx: f64, dy: f64) -> Rect {
        Rect::new(self.left + dx, self.top + dy, self.right + dx, self.bottom + dy)
    }
    pub fn inset(&self, x: f64, y: f64) -> Rect {
        Rect::new(self.left + x, self.top + y, self.right - x, self.bottom - y)
    }
    /// 自己是空盒时取对方（见模块注释）；否则逐边取极值（`Math.min/max`：有 NaN 得 NaN）。
    pub fn union(&self, rr: &Rect) -> Rect {
        if self.is_empty() {
            return *rr;
        }
        use dolce_base::js::{max, min};
        Rect::new(min(self.left, rr.left), min(self.top, rr.top), max(self.right, rr.right), max(self.bottom, rr.bottom))
    }
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }
}

/// 3×3 矩阵，行主序：`[scaleX skewX transX  skewY scaleY transY  p0 p1 p2]`（同 Skija `Matrix33`）。
/// JSON 里只写前 6 元（透视三元恒为 `0 0 1`）。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(from = "[f64; 6]", into = "[f64; 6]")]
pub struct Matrix33 {
    pub mat: [f64; 9],
}

impl From<[f64; 6]> for Matrix33 {
    fn from(a: [f64; 6]) -> Self {
        Matrix33 { mat: [a[0], a[1], a[2], a[3], a[4], a[5], 0.0, 0.0, 1.0] }
    }
}
impl From<Matrix33> for [f64; 6] {
    fn from(m: Matrix33) -> Self {
        [m.mat[0], m.mat[1], m.mat[2], m.mat[3], m.mat[4], m.mat[5]]
    }
}

impl Default for Matrix33 {
    fn default() -> Self {
        Matrix33::IDENTITY
    }
}

impl Matrix33 {
    pub const IDENTITY: Matrix33 = Matrix33 { mat: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0] };

    pub fn translate_x(&self) -> f64 {
        self.mat[2]
    }
    pub fn translate_y(&self) -> f64 {
        self.mat[5]
    }
    pub fn set_translate(&mut self, x: f64, y: f64) {
        self.mat[2] = x;
        self.mat[5] = y;
    }
    pub fn post_translate(&mut self, x: f64, y: f64) {
        self.mat[2] += x;
        self.mat[5] += y;
    }
    /// 只看前 6 元（`-0 === 0`）。
    pub fn is_identity(&self) -> bool {
        let m = &self.mat;
        m[0] == 1.0 && m[1] == 0.0 && m[2] == 0.0 && m[3] == 0.0 && m[4] == 1.0 && m[5] == 0.0
    }
    /// SVG `transform="matrix(a b c d e f)"`（a c e / b d f）。
    pub fn to_svg(&self) -> String {
        let m = &self.mat;
        format!(
            "matrix({} {} {} {} {} {})",
            num_to_string(m[0]),
            num_to_string(m[3]),
            num_to_string(m[1]),
            num_to_string(m[4]),
            num_to_string(m[2]),
            num_to_string(m[5])
        )
    }
    /// `self × other`（先施 `other` 再施 `self`）：子级坐标系换到父级。只算仿射部分。
    pub fn concat(&self, o: &Matrix33) -> Matrix33 {
        let a = &self.mat;
        let b = &o.mat;
        Matrix33 {
            mat: [
                a[0] * b[0] + a[1] * b[3],
                a[0] * b[1] + a[1] * b[4],
                a[0] * b[2] + a[1] * b[5] + a[2],
                a[3] * b[0] + a[4] * b[3],
                a[3] * b[1] + a[4] * b[4],
                a[3] * b[2] + a[4] * b[5] + a[5],
                0.0,
                0.0,
                1.0,
            ],
        }
    }
    pub fn map_point(&self, x: f64, y: f64) -> Point {
        let m = &self.mat;
        Point::new(m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5])
    }
}

/// ARGB 颜色常量（Skija `Color`）。
pub mod colors {
    pub const BLACK: f64 = 4278190080.0; // 0xff000000
    pub const BLUE: f64 = 4278190335.0; // 0xff0000ff
}

/// ToUint32（`x >>> 0`）。
fn to_uint32(x: f64) -> u32 {
    dolce_base::js::to_int32(x) as u32
}

/// `colorToCss`：不透明写 `rgb(r,g,b)`，否则 `rgba(r,g,b,a)`（a 取三位小数）。
pub fn color_to_css(argb: f64) -> String {
    let v = to_uint32(argb);
    let a = (v >> 24) & 0xff;
    let r = (v >> 16) & 0xff;
    let g = (v >> 8) & 0xff;
    let b = v & 0xff;
    if a == 0xff {
        format!("rgb({r},{g},{b})")
    } else {
        format!("rgba({r},{g},{b},{})", to_fixed(a as f64 / 255.0, 3))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn union_empty_takes_other() {
        let flat = Rect::new(0.0, 5.0, 10.0, 5.0);
        let r = Rect::new(1.0, 1.0, 2.0, 2.0);
        assert_eq!(flat.union(&r), r);
        assert_eq!(r.union(&flat), Rect::new(0.0, 1.0, 10.0, 5.0));
    }

    #[test]
    fn matrix_svg() {
        let mut m = Matrix33::IDENTITY;
        assert!(m.is_identity());
        m.set_translate(12.5, -0.0);
        assert!(!m.is_identity());
        assert_eq!(m.to_svg(), "matrix(1 0 0 1 12.5 0)");
        m.mat[5] = -0.0;
        m.mat[2] = 0.0;
        assert!(m.is_identity());
    }

    #[test]
    fn colors_css() {
        assert_eq!(color_to_css(colors::BLACK), "rgb(0,0,0)");
        assert_eq!(color_to_css(colors::BLUE), "rgb(0,0,255)");
        assert_eq!(color_to_css(0x80ff0000u32 as f64), "rgba(255,0,0,0.502)");
        assert_eq!(color_to_css(-16777216.0), "rgb(0,0,0)");
        assert_eq!(color_to_css(0.0), "rgba(0,0,0,0.000)");
    }
}
