//! 图像与矩形的基本类型（对应 `src/omrkit/types.ts` 的 `Binary` / `Rect`）。
use serde::{Deserialize, Serialize};

/// 二值图：1 = 墨，0 = 底。行主序，`data.len() == w * h`。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binary {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u8>,
}

impl Binary {
    pub fn new(w: usize, h: usize) -> Self {
        Binary { w, h, data: vec![0; w * h] }
    }

    /// 出图算没墨。
    #[inline]
    pub fn ink(&self, x: i64, y: i64) -> bool {
        x >= 0 && y >= 0 && (x as usize) < self.w && (y as usize) < self.h && self.data[y as usize * self.w + x as usize] != 0
    }

    /// 一位一像素打包（低位在前），阶段缓存与 TS 的二值图缓存都用这个排法。
    pub fn pack_bits(&self) -> Vec<u8> {
        let mut out = vec![0u8; self.data.len().div_ceil(8)];
        for (i, &v) in self.data.iter().enumerate() {
            if v != 0 {
                out[i >> 3] |= 1 << (i & 7);
            }
        }
        out
    }

    pub fn from_packed(w: usize, h: usize, packed: &[u8]) -> Self {
        let n = w * h;
        let mut data = vec![0u8; n];
        for (i, d) in data.iter_mut().enumerate() {
            *d = (packed[i >> 3] >> (i & 7)) & 1;
        }
        Binary { w, h, data }
    }
}

/// 灰度图：0 = 黑，255 = 白。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gray {
    pub w: usize,
    pub h: usize,
    pub data: Vec<u8>,
}

/// 包围盒，xywh。坐标是 f64：TS 那边是 number，量出来的中心、折算后的框都带小数。
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Rect { x, y, w, h }
    }
    #[inline]
    /// 罩住两框的最小框。
    pub fn union(&self, o: &Rect) -> Rect {
        let (x, y) = (self.x.min(o.x), self.y.min(o.y));
        Rect::new(x, y, self.right().max(o.right()) - x, self.bottom().max(o.bottom()) - y)
    }
    pub fn right(&self) -> f64 {
        self.x + self.w
    }
    #[inline]
    pub fn bottom(&self) -> f64 {
        self.y + self.h
    }
    #[inline]
    pub fn cx(&self) -> f64 {
        self.x + self.w / 2.0
    }
    #[inline]
    pub fn cy(&self) -> f64 {
        self.y + self.h / 2.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pack_roundtrip() {
        let mut b = Binary::new(5, 3);
        for i in [0, 4, 7, 8, 14] {
            b.data[i] = 1;
        }
        assert_eq!(Binary::from_packed(5, 3, &b.pack_bits()), b);
        assert!(b.ink(4, 0) && !b.ink(5, 0) && !b.ink(-1, 0));
    }
}
