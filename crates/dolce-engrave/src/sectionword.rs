//! 段落词（「（副歌）」）的量宽与落点（`engrave/sectionword.ts`）：简谱引擎两处（排版前预演与 justify 之后真正摆）共用同一份判据。

use dolce_text::{CompressMode, Font};

use crate::Env;

#[derive(Clone, Debug, PartialEq)]
pub struct SectionChord {
    pub x0: f64,
    pub x1: f64,
    pub y: f64,
}

/// 段落词落点的几何输入（一行之内，坐标以该行的组为原点）。
#[derive(Clone, Debug, PartialEq)]
pub struct SectionWordGeom {
    pub anchor_x: f64,
    pub width: f64,
    pub size: f64,
    /// 与和弦之间留的净空；不给 = 0.6 个字号
    pub gap: Option<f64>,
    pub base_y: f64,
    pub chords: Vec<SectionChord>,
    pub bar_left: f64,
    pub bar_right: f64,
    pub hang_left: f64,
    pub right_limit: f64,
    pub at_line_start: bool,
    pub straddle: bool,
    pub own_chord_right: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SectionWordSlot {
    pub x: f64,
    pub lifted: bool,
    pub shortfall: f64,
}

/// 段落词能往左挂多远：有左边那条小节线就不越过它，行首最多到版心左缘。
pub fn section_word_hang_left(bar_left: Option<f64>) -> f64 {
    bar_left.unwrap_or(0.0)
}

/// 段落词的字宽与逐字笔位——按标点挤压量；首字开括号的负笔位挪回来。
pub fn section_word_run(font: &Font, text: &str, mode: CompressMode, env: &Env) -> (f64, Option<Vec<f64>>) {
    if mode == CompressMode::None {
        return (font.measure_text(env.mc, text), None);
    }
    let p = font.run(env.mc, text, mode);
    let lead = p.xs.first().copied().unwrap_or(0.0);
    let xs = (p.xs.len() > 1).then(|| p.xs.iter().map(|v| v - lead).collect());
    (p.width - lead, xs)
}

/// 判撞的浮点余量（pt）。
const EDGE_EPS: f64 = 1e-6;

/// 段落词摆哪儿——纯几何。判据与历史见 TS 原文注释。
pub fn place_section_word(g: &SectionWordGeom) -> SectionWordSlot {
    let gap = g.gap.unwrap_or(g.size * 0.6);
    let hit = |x: f64| -> Option<&SectionChord> {
        g.chords
            .iter()
            .find(|c| (c.y - g.base_y).abs() < g.size * 1.5 && x - gap < c.x1 - EDGE_EPS && c.x0 + EDGE_EPS < x + g.width + gap)
    };
    if g.at_line_start {
        let cands: Vec<f64> = if let Some(r) = g.own_chord_right {
            vec![r + gap]
        } else if g.straddle {
            vec![dolce_base::js::max(g.hang_left, g.anchor_x - g.width / 2.0), g.anchor_x]
        } else {
            vec![g.anchor_x]
        };
        for &x in &cands {
            if hit(x).is_none() {
                return SectionWordSlot { x, lifted: false, shortfall: 0.0 };
            }
        }
        let x = cands[0];
        let block = hit(x).unwrap();
        return SectionWordSlot { x, lifted: true, shortfall: x + g.width + gap - block.x0 };
    }
    let Some(first) = hit(g.anchor_x) else {
        return SectionWordSlot { x: g.anchor_x, lifted: false, shortfall: 0.0 };
    };
    let mut cand = first.x1 + gap;
    let mut block = hit(cand);
    while let Some(b) = block {
        if b.x0 >= g.bar_right {
            break;
        }
        let next = b.x1 + gap;
        if next <= cand {
            break;
        }
        cand = next;
        block = hit(cand);
    }
    if block.is_none() && cand < g.bar_right && cand + g.width <= g.right_limit {
        return SectionWordSlot { x: cand, lifted: false, shortfall: 0.0 };
    }
    if let Some(b) = block {
        if cand < g.bar_right && cand + g.width <= g.right_limit {
            return SectionWordSlot { x: cand, lifted: true, shortfall: cand + g.width - b.x0 };
        }
    }
    let left = first.x0 - g.width - gap;
    if left >= g.hang_left && hit(left).is_none() && g.anchor_x > g.hang_left {
        return SectionWordSlot { x: left, lifted: false, shortfall: 0.0 };
    }
    let hang = g.anchor_x - g.width - gap;
    if hang >= g.hang_left && hit(hang).is_none() {
        return SectionWordSlot { x: hang, lifted: false, shortfall: 0.0 };
    }
    let lifted = dolce_base::js::max(0.0, dolce_base::js::min(g.anchor_x, g.right_limit - g.width));
    SectionWordSlot { x: lifted, lifted: true, shortfall: dolce_base::js::max(0.0, cand + g.width - g.bar_right) }
}
