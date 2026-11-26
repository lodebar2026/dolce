//! 仓库自带乐谱字体（Bravura、Bravura Text）由 Rust 自量：不回调宿主，桌面、网页、命令行量出来一样。
//!
//! 表在编译期由 `build.rs` 从 `public/redist/*.otf` 抽出（码点 → advance + 轮廓紧盒、`kern` 字偶距、`ccmp` / `liga` 连字序列），
//! 运行时不带字体文件、不整形。量法同浏览器 `measureText`：advance 逐字相加、相邻两字按字偶距调前一字的 advance，
//! 墨迹盒是各字轮廓盒按落笔点平移后的并（基线 y = 0、向下为正）。不取整、不按 1/64 进位（那是 Chromium 量字的口径，画出来不进位）。
//!
//! 交回宿主量的：串里有字体里没有的码点、有会连成一个字形的序列（连字后的宽与墨迹另算，罕见）、带了 `-kern` 以外的 OpenType 特性。

use dolce_model::base::geom::Rect;

use crate::{FontMetrics, Positions, TextMetrics};

pub struct OwnFace {
    pub upem: f64,
    pub hhea: (i16, i16),
    pub typo: (i16, i16),
    pub use_typo: bool,
    /// 按码点升序
    pub glyphs: &'static [Glyph],
    /// (前字形号, 后字形号, 前字 advance 的增量)，按字形号对升序
    pub kern: &'static [(u16, u16, i32)],
    /// 默认开的连字（码点序列）
    pub ligs: &'static [&'static [u32]],
    /// 默认开的别种替换会碰到的码点（升序）
    pub triggers: &'static [u32],
}

pub struct Glyph {
    pub cp: u32,
    pub gid: u16,
    pub adv: u16,
    pub ink: bool,
    pub x0: i16,
    pub y0: i16,
    pub x1: i16,
    pub y1: i16,
}

include!(concat!(env!("OUT_DIR"), "/ownfonts.rs"));

/// CSS 族串是不是仓库自带、由 Rust 自量的字体（只认单个族名，带引号也行）。
pub fn own_face(family: &str) -> Option<&'static OwnFace> {
    let f = family.trim().trim_matches(|c| c == '"' || c == '\'');
    match f {
        "Bravura" => Some(&BRAVURA),
        "Bravura Text" => Some(&BRAVURA_TEXT),
        _ => None,
    }
}

/// 排好的一串：逐码点落笔点、总宽、墨迹盒（px）
pub struct Laid {
    pub xs: Vec<f64>,
    pub width: f64,
    pub ink: Option<Rect>,
}

impl OwnFace {
    fn glyph(&self, cp: u32) -> Option<&Glyph> {
        self.glyphs.binary_search_by_key(&cp, |g| g.cp).ok().map(|i| &self.glyphs[i])
    }

    fn kern_of(&self, a: u16, b: u16) -> i32 {
        self.kern.binary_search_by_key(&(a, b), |&(x, y, _)| (x, y)).map_or(0, |i| self.kern[i].2)
    }

    /// 排一串；交宿主量的情形回 None。`kern`：宿主画 SVG 文字时做不做字偶距（WebKit 不做）。
    pub fn lay(&self, text: &str, size: f64, kern: bool) -> Option<Laid> {
        let cps: Vec<u32> = text.chars().map(|c| c as u32).collect();
        if cps.iter().any(|cp| self.triggers.binary_search(cp).is_ok()) {
            return None;
        }
        if cps.len() > 1 && self.ligs.iter().any(|l| cps.windows(l.len()).any(|w| w == *l)) {
            return None;
        }
        let gs: Vec<&Glyph> = cps.iter().map(|&cp| self.glyph(cp)).collect::<Option<_>>()?;
        let k = size / self.upem;
        let mut xs = Vec::with_capacity(gs.len());
        let mut pen: i64 = 0;
        let mut ink: Option<Rect> = None;
        for (i, g) in gs.iter().enumerate() {
            let x = pen as f64 * k;
            xs.push(x);
            if g.ink {
                let r = Rect::new(x + g.x0 as f64 * k, -(g.y1 as f64) * k, x + g.x1 as f64 * k, -(g.y0 as f64) * k);
                ink = Some(match ink {
                    Some(u) => u.union(&r),
                    None => r,
                });
            }
            pen += g.adv as i64;
            if kern {
                if let Some(n) = gs.get(i + 1) {
                    pen += self.kern_of(g.gid, n.gid) as i64;
                }
            }
        }
        Some(Laid { xs, width: pen as f64 * k, ink })
    }

    pub fn metrics(&self, text: &str, size: f64, kern: bool) -> Option<TextMetrics> {
        let l = self.lay(text, size, kern)?;
        Some(TextMetrics { width: l.width, bbox: l.ink.unwrap_or_default() })
    }

    pub fn positions(&self, text: &str, size: f64, kern: bool) -> Option<Positions> {
        let l = self.lay(text, size, kern)?;
        Some(Positions { xs: l.xs, width: l.width })
    }

    /// 字体全局 ascent / descent：浏览器口径（`USE_TYPO_METRICS` 置位取 OS/2 typo，否则 hhea；取整）
    pub fn font_metrics(&self, size: f64) -> FontMetrics {
        let (a, d) = if self.use_typo { self.typo } else { self.hhea };
        let k = size / self.upem;
        FontMetrics { ascent: -dolce_model::base::js::round(a as f64 * k), descent: dolce_model::base::js::round(-(d as f64) * k) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables() {
        let b = own_face("Bravura").expect("Bravura");
        assert_eq!(b.upem, 1000.0);
        assert!(b.glyphs.windows(2).all(|w| w[0].cp < w[1].cp));
        assert!(b.kern.windows(2).all(|w| (w[0].0, w[0].1) < (w[1].0, w[1].1)));
        assert!(own_face("'Bravura Text'").is_some());
        assert!(own_face("Bravura, serif").is_none());
        // 升号（U+E262）有墨，宽为正
        let m = b.metrics("\u{e262}", 20.0, true).expect("升号");
        assert!(m.width > 0.0 && m.bbox.right > m.bbox.left && m.bbox.top < 0.0);
        // 字体里没有的字交宿主
        assert!(b.metrics("中", 20.0, true).is_none());
    }
}
