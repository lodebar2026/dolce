//! 谱表与**谱表局部坐标**：把页面上的 (x, y) 换成 (x, 音级位置)，按该处实测的线位算（谱线弯、斜都照实，不推平不纠斜）。
//!
//! 音级位置 `pos`：第一线（最上）为 0，往下每半个线距 +1，第五线为 8；线上是偶数、间里是奇数，谱表上方为负。
//! 读音高时按**相邻两条线之间的相对位置**插值（线距不匀、页面倾斜都不偏）；谱表外按最近那个间的线距外推。
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// 一页的尺子：线距（相邻两线中心的距离）与线宽（像素或点，与坐标同单位）。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Unit {
    pub space: f64,
    pub thick: f64,
}

/// 谱线随 x 的共同偏移：每 `step` 列一个采样，五条线共用（单条线的采样被符头、符杠带偏，五条一起量才稳）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LineCurve {
    pub step: usize,
    pub d: Vec<f32>,
}

impl LineCurve {
    #[inline]
    pub fn at(&self, x: f64) -> f64 {
        if self.d.is_empty() {
            return 0.0;
        }
        let c = (x.max(0.0) / self.step as f64).round() as usize;
        self.d[c.min(self.d.len() - 1)] as f64
    }
}

/// 一行谱表。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Staff {
    /// 五条线在曲线偏移为 0 处的 y（自上而下）。单线谱（打击乐）也是五条：实线当第三线，其余按线距补出（`one_line`）。
    pub ys: [f64; 5],
    /// 每条线的线宽（像素带厚）。
    pub thick: [f64; 5],
    /// 平直的谱行没有曲线（`None` 即偏移恒为 0）。
    pub curve: Option<Arc<LineCurve>>,
    pub left: f64,
    pub right: f64,
    /// 单线谱：只有第三线是谱面上的。
    pub one_line: bool,
}

impl Staff {
    /// 本行的线距（首末线距离 / 4）。
    pub fn space(&self) -> f64 {
        (self.ys[4] - self.ys[0]) / 4.0
    }

    #[inline]
    fn off(&self, x: f64) -> f64 {
        self.curve.as_ref().map_or(0.0, |c| c.at(x))
    }

    /// 第 k 条线在 x 处的 y。
    #[inline]
    pub fn line_y(&self, k: usize, x: f64) -> f64 {
        self.ys[k] + self.off(x)
    }

    pub fn top(&self, x: f64) -> f64 {
        self.line_y(0, x)
    }

    pub fn bottom(&self, x: f64) -> f64 {
        self.line_y(4, x)
    }

    /// (x, y) 的音级位置（小数）。
    pub fn pos(&self, x: f64, y: f64) -> f64 {
        let o = self.off(x);
        let ys = self.ys.map(|v| v + o);
        if y <= ys[0] {
            return (y - ys[0]) / (ys[1] - ys[0]) * 2.0;
        }
        if y >= ys[4] {
            return 8.0 + (y - ys[4]) / (ys[4] - ys[3]) * 2.0;
        }
        let mut k = 0;
        while k < 3 && y > ys[k + 1] {
            k += 1;
        }
        k as f64 * 2.0 + (y - ys[k]) / (ys[k + 1] - ys[k]) * 2.0
    }

    /// 音级位置 → x 处的 y（`pos` 的逆）。
    pub fn y_of(&self, x: f64, pos: f64) -> f64 {
        let o = self.off(x);
        let ys = self.ys.map(|v| v + o);
        if pos <= 0.0 {
            return ys[0] + pos / 2.0 * (ys[1] - ys[0]);
        }
        if pos >= 8.0 {
            return ys[4] + (pos - 8.0) / 2.0 * (ys[4] - ys[3]);
        }
        let k = ((pos / 2.0).floor() as usize).min(3);
        ys[k] + (pos - k as f64 * 2.0) / 2.0 * (ys[k + 1] - ys[k])
    }

    /// y 落在谱表首末线（含上下 `margin` 个线距）之间。
    pub fn covers(&self, x: f64, y: f64, margin: f64) -> bool {
        let m = margin * self.space();
        y >= self.top(x) - m && y <= self.bottom(x) + m
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(curve: Option<LineCurve>) -> Staff {
        Staff { ys: [100.0, 110.0, 120.0, 131.0, 142.0], thick: [2.0; 5], curve: curve.map(Arc::new), left: 0.0, right: 400.0, one_line: false }
    }

    #[test]
    fn positions() {
        let s = st(None);
        assert_eq!(s.pos(0.0, 100.0), 0.0);
        assert_eq!(s.pos(0.0, 105.0), 1.0);
        assert_eq!(s.pos(0.0, 136.5), 7.0); // 不匀的间按本间插值
        assert_eq!(s.pos(0.0, 90.0), -2.0);
        assert_eq!(s.pos(0.0, 153.0), 10.0);
        for p in [-3.0, 0.0, 2.5, 7.0, 9.5] {
            assert!((s.pos(0.0, s.y_of(0.0, p)) - p).abs() < 1e-9);
        }
    }

    #[test]
    fn curved() {
        let s = st(Some(LineCurve { step: 4, d: vec![0.0, 0.0, 3.0, 3.0] }));
        assert_eq!(s.line_y(0, 0.0), 100.0);
        assert_eq!(s.line_y(0, 8.0), 103.0);
        assert_eq!(s.pos(8.0, 103.0), 0.0);
        assert_eq!(s.line_y(0, 1000.0), 103.0); // 越界取末采样
    }
}
